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

interface UserPayload {
  login?: string;
}

interface PullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
}

interface IssueCommentPayload {
  id: number;
  user: UserPayload | null;
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
  user: UserPayload | null;
  body: string | null;
  submitted_at: string;
}

interface DeliveryPayload {
  action: string;
  issue: { number: number; pull_request?: unknown };
  comment: IssueCommentPayload & ReviewCommentPayload;
  review: ReviewPayload;
  pull_request: PullRequestPayload;
}

/**
 * Turns one GitHub webhook delivery into the domain events the poller would
 * have produced. Payload shapes are trusted once the signature has been
 * verified; only the fields the rules branch on are checked.
 */
export function normalizeDelivery(
  event: string,
  payload: unknown,
): NormalizeResult {
  if (!isWebhookEvent(event)) return ignored("unsupported-event");
  const repo = repoOf(payload);
  if (!repo) return ignored("missing-repository");
  const p = payload as DeliveryPayload;

  if (event === "issue_comment") {
    if (p.action !== "created") return ignored("uninteresting-action");
    if (!p.issue.pull_request) return ignored("not-a-pull-request");
    const n = p.issue.number;
    const c = p.comment;
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

  const wanted = WANTED_ACTIONS[event];
  if (!wanted.includes(p.action)) return ignored("uninteresting-action");
  const pr = pullRequestOf(repo, p.pull_request);
  if (pr.draft) return ignored("draft");
  if (pr.fromFork) return ignored("fork");

  if (event === "pull_request") {
    return { kind: "events", events: [{ kind: "pull_request_ready", pr }] };
  }

  if (event === "pull_request_review") {
    const r = p.review;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    draft: raw.draft,
    // A deleted head repo arrives as null; treat it as foreign.
    fromFork: raw.head.repo?.full_name !== raw.base.repo?.full_name,
  };
}

function authorOf(user: UserPayload | null): string {
  return user?.login ?? "unknown";
}
