import { commentKey } from "./batching.js";
import type { DomainEvent, PullRequest, RepoRef } from "./events.js";

export const WEBHOOK_EVENTS = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type NormalizeResult =
  | { kind: "events"; events: DomainEvent[] }
  | {
      kind: "needs_pull_request";
      prNumber: number;
      repo: RepoRef;
      build: (pr: PullRequest) => DomainEvent[];
    }
  | { kind: "ignored"; reason: string };

/** Maps the payload's repo to the watched repo it names, or null when unwatched. */
export type RepoResolver = (repo: RepoRef) => RepoRef | null;

interface DeliveryPayload {
  action?: unknown;
  issue?: unknown;
  comment?: unknown;
  review?: unknown;
  pull_request?: unknown;
}

interface IssuePayload {
  number: number;
  pull_request?: unknown;
}

interface RefPayload {
  ref: string;
  repo?: unknown;
}

interface PullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  draft?: unknown;
  head: RefPayload;
  base: RefPayload;
}

interface IssueCommentPayload {
  id: number;
  user?: unknown;
  body: string;
  created_at: string;
}

interface ReviewCommentPayload extends IssueCommentPayload {
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  pull_request_review_id: number | null;
}

interface ReviewPayload {
  id: number;
  user?: unknown;
  body: string | null;
  submitted_at: string;
}

/**
 * Turns one GitHub webhook delivery into the domain events the poller would
 * have produced. Every object and field the events are built from is checked;
 * a payload that does not match is ignored as malformed rather than thrown on.
 * The resolved repo, not the payload's casing, keys the events.
 */
export function normalizeDelivery(
  event: string,
  payload: unknown,
  resolveRepo: RepoResolver = (repo) => repo,
): NormalizeResult {
  if (!isWebhookEvent(event)) return ignored("unsupported-event");
  const payloadRepo = repoOf(payload);
  if (!payloadRepo) return ignored("missing-repository");
  const repo = resolveRepo(payloadRepo);
  if (!repo) return ignored("repo-not-watched");
  const p = payload as DeliveryPayload;

  if (event === "issue_comment") {
    if (p.action !== "created") return ignored("uninteresting-action");
    if (!isIssue(p.issue)) return ignored("malformed-payload");
    if (!p.issue.pull_request) return ignored("not-a-pull-request");
    const c = p.comment;
    if (!isIssueComment(c)) return ignored("malformed-payload");
    const n = p.issue.number;
    return {
      kind: "needs_pull_request",
      prNumber: n,
      repo,
      build: (pr) => [
        {
          kind: "comment",
          pr,
          comment: {
            key: commentKey(repo, n, "issue", c.id),
            id: c.id,
            kind: "issue",
            author: authorOf(c.user),
            body: c.body,
            createdAt: c.created_at,
          },
        },
      ],
    };
  }

  if (!WANTED_ACTIONS[event].includes(p.action as string))
    return ignored("uninteresting-action");
  if (!isPullRequest(p.pull_request)) return ignored("malformed-payload");
  const pr = pullRequestOf(repo, p.pull_request);
  if (pr.draft) return ignored("draft");
  if (pr.fromFork) return ignored("fork");

  if (event === "pull_request") {
    return { kind: "events", events: [{ kind: "pull_request_ready", pr }] };
  }

  if (event === "pull_request_review") {
    const r = p.review;
    if (!isReview(r)) return ignored("malformed-payload");
    if (!r.body) return ignored("empty-review-body");
    return {
      kind: "events",
      events: [
        {
          kind: "comment",
          pr,
          comment: {
            key: commentKey(repo, pr.number, "review_summary", r.id),
            id: r.id,
            kind: "review_summary",
            author: authorOf(r.user),
            body: r.body,
            createdAt: r.submitted_at,
          },
        },
      ],
    };
  }

  const c = p.comment;
  if (!isReviewComment(c)) return ignored("malformed-payload");
  return {
    kind: "events",
    events: [
      {
        kind: "comment",
        pr,
        comment: {
          key: commentKey(repo, pr.number, "review", c.id),
          id: c.id,
          kind: "review",
          author: authorOf(c.user),
          body: c.body,
          createdAt: c.created_at,
          reviewId: c.pull_request_review_id,
          review: {
            path: c.path,
            line: c.line ?? c.original_line,
            diffHunk: c.diff_hunk,
          },
        },
      },
    ],
  };
}

const WANTED_ACTIONS: Record<
  Exclude<WebhookEvent, "issue_comment">,
  string[]
> = {
  pull_request_review_comment: ["created"],
  pull_request_review: ["submitted"],
  pull_request: ["opened", "ready_for_review"],
};

function ignored(reason: string): NormalizeResult {
  return { kind: "ignored", reason };
}

function isWebhookEvent(event: string): event is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(event);
}

function repoOf(payload: unknown): RepoRef | null {
  if (!isRecord(payload) || !isRecord(payload.repository)) return null;
  const { name, owner } = payload.repository;
  if (typeof name !== "string" || !isRecord(owner)) return null;
  if (typeof owner.login !== "string") return null;
  return { owner: owner.login, repo: name };
}

function pullRequestOf(repo: RepoRef, raw: PullRequestPayload): PullRequest {
  return {
    repo,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    draft: raw.draft === true,
    fromFork: isFromFork(raw),
  };
}

/** Fails closed: a missing (e.g. deleted) head repo counts as a fork. */
function isFromFork(raw: PullRequestPayload): boolean {
  const head = fullNameOf(raw.head);
  return head === null || head !== fullNameOf(raw.base);
}

function fullNameOf(ref: RefPayload): string | null {
  return isRecord(ref.repo) && typeof ref.repo.full_name === "string"
    ? ref.repo.full_name
    : null;
}

function authorOf(user: unknown): string {
  return isRecord(user) && typeof user.login === "string"
    ? user.login
    : "unknown";
}

function isIssue(value: unknown): value is IssuePayload {
  return isRecord(value) && typeof value.number === "number";
}

function isPullRequest(value: unknown): value is PullRequestPayload {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    isStringOrNull(value.body) &&
    isRef(value.head) &&
    isRef(value.base)
  );
}

function isRef(value: unknown): value is RefPayload {
  return isRecord(value) && typeof value.ref === "string";
}

function isIssueComment(value: unknown): value is IssueCommentPayload {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.body === "string" &&
    typeof value.created_at === "string"
  );
}

function isReviewComment(value: unknown): value is ReviewCommentPayload {
  if (!isIssueComment(value)) return false;
  const fields = value as unknown as Record<string, unknown>;
  return (
    typeof fields.path === "string" &&
    typeof fields.diff_hunk === "string" &&
    isNumberOrNull(fields.line) &&
    isNumberOrNull(fields.original_line) &&
    isNumberOrNull(fields.pull_request_review_id)
  );
}

function isReview(value: unknown): value is ReviewPayload {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    isStringOrNull(value.body) &&
    typeof value.submitted_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || typeof value === "number";
}
