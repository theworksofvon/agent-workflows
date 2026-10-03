import type { RepoStatePort } from "../adapters/state/state.interface.js";
import {
  dropReason,
  groupKeyFor,
  type IngestPolicy,
} from "../domain/batching.js";
import type { Comment, PullRequest } from "../domain/events.js";

export interface IntakeResult {
  accepted: boolean;
  reason?: string;
}

/**
 * Filters one comment and adds it to its pending group. Cursors are not
 * touched here: only the poller moves them, so a webhook delivery that fails
 * halfway leaves the comment for the next reconciliation poll to pick up.
 */
export function ingestComment(args: {
  state: RepoStatePort;
  pr: PullRequest;
  comment: Comment;
  now: number;
  policy: IngestPolicy;
}): IntakeResult {
  const { state, pr, comment, now, policy } = args;
  const dropped = dropReason(comment, policy);
  if (dropped) return { accepted: false, reason: dropped };
  if (state.hasProcessedComment(comment.key))
    return { accepted: false, reason: "processed" };
  state.addPendingComment({
    groupKey: groupKeyFor(pr.number, comment),
    pr,
    comment,
    now,
  });
  return { accepted: true };
}
