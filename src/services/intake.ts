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

export function ingestComment(args: {
  state: RepoStatePort;
  pr: PullRequest;
  comment: Comment;
  now: number;
  policy: IngestPolicy;
}): IntakeResult {
  const { state, pr, comment, now, policy } = args;
  advanceCursor(state, pr.number, comment);
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

function advanceCursor(
  state: RepoStatePort,
  prNumber: number,
  comment: Comment,
): void {
  if (comment.kind === "issue") {
    state.setIssueCommentCursor(
      prNumber,
      Math.max(state.getIssueCommentCursor(prNumber), comment.id),
    );
  } else if (comment.kind === "review") {
    state.setReviewCommentCursor(
      prNumber,
      Math.max(state.getReviewCommentCursor(prNumber), comment.id),
    );
  }
}
