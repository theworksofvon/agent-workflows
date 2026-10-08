import type { RepoRef } from "./pull-request.js";

export interface Account {
  login: string;
  avatarUrl: string | null;
}

export type PullState = "open" | "draft" | "merged" | "closed";
export type ChecksRollup = "passing" | "failing" | "pending" | null;
export type CheckStatus =
  "pending" | "success" | "failure" | "cancelled" | "skipped" | "neutral";
export type ReviewDecision =
  "approved" | "changes_requested" | "review_required";
export type InboxGroup = "reviewRequested" | "authored" | "involved";

export interface Check {
  name: string;
  workflowName: string | null;
  status: CheckStatus;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** The latest commit on the head branch: who pushed it and when. */
export interface LastCommit {
  authorLogin: string | null;
  authorName: string | null;
  committedAt: string | null;
}

/** A pull request as a list row shows it, before inbox grouping. */
export interface PullCard {
  repo: RepoRef;
  number: number;
  title: string;
  url: string;
  author: Account;
  headRef: string;
  baseRef: string;
  state: PullState;
  reviewDecision: ReviewDecision | null;
  updatedAt: string;
  lastCommit: LastCommit | null;
  checks: ChecksRollup;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/** A card with what the PR preview and a guided review snapshot also need. */
export interface PullDetail extends PullCard {
  body: string | null;
  headSha: string;
  fromFork: boolean;
}

export interface InboxPull extends PullCard {
  groups: InboxGroup[];
  /** The latest guided review session for this PR (any status). */
  sessionId: string | null;
}

/**
 * The search query of each inbox group, run as the account it is for. Newest
 * update first, so a group past the page limit drops the oldest PRs.
 */
export const INBOX_QUERIES: Record<InboxGroup, string> = {
  reviewRequested:
    "is:pr is:open archived:false review-requested:@me sort:updated-desc",
  authored: "is:pr is:open archived:false author:@me sort:updated-desc",
  involved:
    "is:pr is:open archived:false involves:@me -author:@me -review-requested:@me sort:updated-desc",
};

export const INBOX_GROUPS = Object.keys(INBOX_QUERIES) as InboxGroup[];

/**
 * A check run reports `status` and, once completed, a `conclusion`; a
 * commit status reports only `state`. A completed run that asks for action
 * blocks the merge, so it counts as a failure.
 */
export function toCheckStatus(raw: {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}): CheckStatus {
  const status = raw.status?.trim().toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * A failure outranks a check that still runs, because a red run does not
 * turn green when it finishes. Null when no check passed, failed, or waits.
 */
export function checksRollup(statuses: CheckStatus[]): ChecksRollup {
  if (statuses.includes("failure") || statuses.includes("cancelled"))
    return "failing";
  if (statuses.includes("pending")) return "pending";
  return statuses.includes("success") ? "passing" : null;
}

/**
 * A rollup lists runs, not checks, so a re-run arrives beside the run it
 * replaces. Keeps the newest run per (workflowName, name) at the position
 * where the check first appeared; a tie goes to the later entry.
 */
export function dedupeChecks(checks: Check[]): Check[] {
  const newest = new Map<string, Check>();
  for (const check of checks) {
    const key = `${check.workflowName ?? ""}\0${check.name}`;
    const kept = newest.get(key);
    if (kept === undefined || isAtLeastAsNew(at(check), at(kept)))
      newest.set(key, check);
  }
  return [...newest.values()];
}

export function pullState(state: string, isDraft: boolean): PullState {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return isDraft ? "draft" : "open";
}

export function reviewDecision(
  value: string | null | undefined,
): ReviewDecision | null {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

/**
 * One row per PR, carrying every group whose search found it, newest
 * update first.
 */
export function mergeInbox(found: Record<InboxGroup, PullCard[]>): InboxPull[] {
  const byPull = new Map<string, InboxPull>();
  for (const group of INBOX_GROUPS) {
    for (const card of found[group]) {
      const key = `${card.repo.owner}/${card.repo.repo}#${card.number}`;
      const row = byPull.get(key);
      if (row) {
        if (!row.groups.includes(group)) row.groups.push(group);
        continue;
      }
      byPull.set(key, { ...card, groups: [group], sessionId: null });
    }
  }
  return [...byPull.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

function at(check: Check): string | null {
  return check.completedAt ?? check.startedAt;
}

/** UTC ISO-8601 timestamps order correctly as plain text. */
function isAtLeastAsNew(candidate: string | null, kept: string | null) {
  if (candidate === null) return kept === null;
  return kept === null || candidate >= kept;
}
