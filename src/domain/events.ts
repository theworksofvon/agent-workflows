export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequest {
  repo: RepoRef;
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
  /** true when head.repo differs from base.repo */
  fromFork: boolean;
}

export type CommentKind = "issue" | "review" | "review_summary";

export interface Comment {
  key: string;
  id: number;
  kind: CommentKind;
  author: string;
  body: string;
  createdAt: string;
  reviewId?: number | null;
  review?: { path: string; line: number | null; diffHunk: string };
}

export interface CommentBatch {
  repo: RepoRef;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  headRef: string;
  baseRef: string;
  batchId: string;
  groupKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  comments: Comment[];
}

export interface BatchHistory {
  batchId: string;
  handledAt: string;
  agent: string;
  exitCode: number;
  commitCount: number;
  commentKeys: string[];
  summary: string;
}

export interface ReviewTarget {
  repo: RepoRef;
  prNumber: number;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface ReviewContext {
  repo: RepoRef;
  prNumber: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  files: PullRequestFile[];
}

export interface RawDelivery {
  id: string;
  event: string;
  signature256: string | null;
  body: string;
}

export type DomainEvent =
  | { kind: "comment"; pr: PullRequest; comment: Comment }
  | { kind: "pull_request_ready"; pr: PullRequest };
