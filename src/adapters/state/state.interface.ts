import type {
  BatchHistory,
  Comment,
  CommentBatch,
  PullRequest,
  RepoRef,
} from "../../domain/events.js";

export interface ReviewRunHistory {
  reviewedAt: string;
  agent: string;
  findingCount: number;
  postedFindingCount: number;
  dryRun: boolean;
  summary: string;
}

export interface RepoStatePort {
  isPollingInitialized(): boolean;
  markPollingInitialized(): void;
  getIssueCommentCursor(prNumber: number): number;
  setIssueCommentCursor(prNumber: number, id: number): void;
  getReviewCommentCursor(prNumber: number): number;
  setReviewCommentCursor(prNumber: number, id: number): void;
  hasProcessedComment(key: string): boolean;
  addPendingComment(args: {
    groupKey: string;
    pr: PullRequest;
    comment: Comment;
    now: number;
  }): void;
  takeReadyCommentBatches(
    now: number,
    policy: { quietWindowMs: number; minComments: number; maxWaitMs: number },
  ): CommentBatch[];
  markBatchCompleted(batch: CommentBatch): void;
  pauseBatchForRetry(args: {
    batch: CommentBatch;
    retryAfterMs: number;
    error: string;
  }): void;
  getRecentPrHistory(prNumber: number, limit: number): BatchHistory[];
  recordPrHistory(prNumber: number, entry: BatchHistory): void;
  getPostedReviewFindingKeys(prNumber: number): string[];
  recordReviewRun(args: {
    prNumber: number;
    entry: ReviewRunHistory;
    postedFindingKeys: string[];
  }): void;
  hasSeenDelivery(id: string): boolean;
  markDeliverySeen(id: string): void;
}

export type StateFactory = (repo: RepoRef) => RepoStatePort;
