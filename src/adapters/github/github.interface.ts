import type {
  PullRequest,
  PullRequestFile,
  RepoRef,
} from "../../domain/events.js";

export interface IssueCommentRecord {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}
export interface ReviewCommentRecord extends IssueCommentRecord {
  path: string;
  line: number | null;
  originalLine: number | null;
  diffHunk: string;
  reviewId: number | null;
}
export interface ReviewCommentDraft {
  path: string;
  line: number;
  body: string;
}
export interface HookRecord {
  id: number;
  url: string;
  events: string[];
  active: boolean;
}
export interface HookDelivery {
  id: number;
  event: string;
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

export interface GitHubPort {
  listOpenPRs(repo: RepoRef): Promise<PullRequest[]>;
  getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequest>;
  listIssueComments(
    repo: RepoRef,
    prNumber: number,
  ): Promise<IssueCommentRecord[]>;
  listReviewComments(
    repo: RepoRef,
    prNumber: number,
  ): Promise<ReviewCommentRecord[]>;
  listPullRequestFiles(
    repo: RepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]>;
  createComment(repo: RepoRef, prNumber: number, body: string): Promise<void>;
  replyToReviewComment(
    repo: RepoRef,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  createPullRequestReview(args: {
    repo: RepoRef;
    prNumber: number;
    body: string;
    comments: ReviewCommentDraft[];
  }): Promise<void>;
  listHooks(repo: RepoRef): Promise<HookRecord[]>;
  createHook(
    repo: RepoRef,
    args: { url: string; secret: string; events: string[] },
  ): Promise<HookRecord>;
  updateHook(
    repo: RepoRef,
    hookId: number,
    args: { url: string; secret: string; events: string[] },
  ): Promise<HookRecord>;
  listHookDeliveries(repo: RepoRef, hookId: number): Promise<HookDelivery[]>;
}
