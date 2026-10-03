import type { Comment, CommentBatch, RepoRef } from "./events.js";

/**
 * Marker tag embedded in every comment this daemon writes. Intake filters
 * these out so the agent never reacts to its own output. An HTML comment is
 * invisible in the rendered PR but trivially greppable.
 */
export const MARKER_TAG = "<!-- agent-workflows:bot -->";

export interface IngestPolicy {
  allowedAuthors: string[] | null;
  agentSelfUser: string | null;
}

export function commentKey(
  repo: RepoRef,
  prNumber: number,
  kind: Comment["kind"],
  id: number,
): string {
  return `${repo.owner}/${repo.repo}#${prNumber}:${kind}:${id}`;
}

export function groupKeyFor(prNumber: number, comment: Comment): string {
  if (comment.kind !== "review") return `pr:${prNumber}:conversation`;
  return comment.reviewId
    ? `pr:${prNumber}:review:${comment.reviewId}`
    : `pr:${prNumber}:review-comments`;
}

export function dropReason(
  comment: Comment,
  policy: IngestPolicy,
): "self" | "bot" | "author-not-allowed" | null {
  const author = comment.author.toLowerCase();
  if (comment.body.includes(MARKER_TAG)) return "self";
  if (policy.agentSelfUser && author === policy.agentSelfUser.toLowerCase())
    return "self";
  if (author.endsWith("[bot]")) return "bot";
  if (
    policy.allowedAuthors &&
    !policy.allowedAuthors.some((a) => a.toLowerCase() === author)
  )
    return "author-not-allowed";
  return null;
}

const RETRYABLE = [
  "rate limit",
  "usage limit",
  "quota",
  "too many requests",
  "429",
  "temporarily unavailable",
  "try again later",
  "capacity",
];

export function isRetryableAgentFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return RETRYABLE.some((needle) => normalized.includes(needle));
}

export function summarizeBatch(p: CommentBatch, commitCount: number): string {
  const files = [
    ...new Set(
      p.comments
        .map((comment) => comment.review?.path)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  const authors = [
    ...new Set(p.comments.map((comment) => `@${comment.author}`)),
  ];
  const fileText =
    files.length > 0 ? ` on ${files.slice(0, 5).join(", ")}` : "";
  const moreFiles =
    files.length > 5 ? ` and ${files.length - 5} more file(s)` : "";
  const result =
    commitCount > 0
      ? `produced ${commitCount} commit(s)`
      : "produced no commits";
  return `Handled batch from ${authors.join(", ")} with ${p.comments.length} comment(s)${fileText}${moreFiles}; ${result}`;
}
