import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, RepoSpec } from "../config.js";
import type {
  PRCommentBatchHistory,
  PRCommentItem,
  PRCommentPayload,
} from "./poller.js";
import { log } from "../log.js";

export interface GitHubRepoCursors {
  issueCommentId: number;
  reviewCommentId: number;
}

export interface PendingCommentGroup extends PRCommentPayload {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  retryAfterMs?: number;
  lastError?: string;
}

export interface GitHubPullRequestState {
  cursors: GitHubRepoCursors;
  commentBatchHistory: PRCommentBatchHistory[];
  reviewRunHistory: PRReviewRunHistory[];
  postedReviewFindingKeys: string[];
}

export interface GitHubRepoState {
  cursors: GitHubRepoCursors;
  pendingCommentGroups: Record<string, PendingCommentGroup>;
  processedCommentKeys: string[];
  prs: Record<string, GitHubPullRequestState>;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  draft?: boolean;
}

export interface PRReviewRunHistory {
  reviewedAt: string;
  agent: string;
  findingCount: number;
  postedFindingCount: number;
  dryRun: boolean;
  summary: string;
}

const defaultState = (): GitHubRepoState => ({
  cursors: {
    issueCommentId: 0,
    reviewCommentId: 0,
  },
  pendingCommentGroups: {},
  processedCommentKeys: [],
  prs: {},
});

/**
 * Typed, per-repository GitHub state.
 *
 * Each watched repo gets its own file under:
 *   state/github/<owner>/<repo>.json
 *
 * This keeps polling and prompt-context lookups scoped to one repo instead of
 * growing a shared process-wide JSON document.
 */
export class GitHubRepoStateStore {
  private state: GitHubRepoState = defaultState();
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly repo: RepoSpec,
    private readonly limits: {
      processedCommentKeyLimit: number;
      commentBatchHistoryLimit: number;
    },
  ) {
    const dir = join(stateDir, "github", repo.owner);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${repo.repo}.json`);
    this.load();
  }

  static fromConfig(config: Config, repo: RepoSpec): GitHubRepoStateStore {
    return new GitHubRepoStateStore(config.stateDir, repo, {
      processedCommentKeyLimit: config.processedCommentKeyLimit,
      commentBatchHistoryLimit: config.commentBatchHistoryLimit,
    });
  }

  getIssueCommentCursor(prNumber: number): number {
    return this.getPrState(prNumber).cursors.issueCommentId;
  }

  setIssueCommentCursor(prNumber: number, id: number): void {
    this.getPrState(prNumber).cursors.issueCommentId = id;
    this.persist();
  }

  getReviewCommentCursor(prNumber: number): number {
    return this.getPrState(prNumber).cursors.reviewCommentId;
  }

  setReviewCommentCursor(prNumber: number, id: number): void {
    this.getPrState(prNumber).cursors.reviewCommentId = id;
    this.persist();
  }

  hasProcessedComment(key: string): boolean {
    return this.state.processedCommentKeys.includes(key);
  }

  addPendingComment(args: {
    groupKey: string;
    pr: PullRequestSnapshot;
    comment: PRCommentItem;
    now: number;
  }): void {
    const { groupKey, pr, comment, now } = args;
    const existing = this.state.pendingCommentGroups[groupKey];
    const comments = existing?.comments ?? [];
    if (comments.some((c) => c.key === comment.key)) return;

    const firstSeenAtMs = existing?.firstSeenAtMs ?? now;
    this.state.pendingCommentGroups[groupKey] = {
      repo: this.repo,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      batchId: existing?.batchId ?? `batch:${this.repo.owner}/${this.repo.repo}:${groupKey}:${now}`,
      groupKey,
      firstSeenAt: new Date(firstSeenAtMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      attempts: existing?.attempts ?? 0,
      firstSeenAtMs,
      lastSeenAtMs: now,
      retryAfterMs: existing?.retryAfterMs,
      lastError: existing?.lastError,
      comments: [...comments, comment].sort((a, b) => {
        const byTime = Number(new Date(a.createdAt)) - Number(new Date(b.createdAt));
        return byTime === 0 ? a.id - b.id : byTime;
      }),
    };
    this.persist();
  }

  takeReadyCommentBatches(now: number, windowMs: number): PRCommentPayload[] {
    const ready: PRCommentPayload[] = [];
    for (const [groupKey, group] of Object.entries(this.state.pendingCommentGroups)) {
      if (group.retryAfterMs !== undefined && now < group.retryAfterMs) continue;
      if (now - group.lastSeenAtMs < windowMs) continue;
      group.attempts += 1;
      group.retryAfterMs = undefined;
      group.lastError = undefined;
      ready.push({
        repo: group.repo,
        prNumber: group.prNumber,
        prTitle: group.prTitle,
        prBody: group.prBody,
        headRef: group.headRef,
        baseRef: group.baseRef,
        batchId: group.batchId,
        groupKey: group.groupKey,
        firstSeenAt: group.firstSeenAt,
        lastSeenAt: group.lastSeenAt,
        attempts: group.attempts,
        comments: group.comments,
      });
      delete this.state.pendingCommentGroups[groupKey];
    }

    this.persist();
    return ready;
  }

  markBatchCompleted(batch: PRCommentPayload): void {
    this.markCommentsProcessed(batch.comments.map((comment) => comment.key));
  }

  pauseBatchForRetry(args: {
    batch: PRCommentPayload;
    retryAfterMs: number;
    error: string;
  }): void {
    const { batch, retryAfterMs, error } = args;
    this.state.pendingCommentGroups[batch.groupKey] = {
      ...batch,
      firstSeenAtMs: Number(new Date(batch.firstSeenAt)),
      lastSeenAtMs: Number(new Date(batch.lastSeenAt)),
      retryAfterMs,
      lastError: error,
    };
    this.persist();
  }

  getRecentPrHistory(prNumber: number, limit: number): PRCommentBatchHistory[] {
    const history = this.state.prs[String(prNumber)]?.commentBatchHistory ?? [];
    return takeLatest(history, limit);
  }

  recordPrHistory(prNumber: number, entry: PRCommentBatchHistory): void {
    const key = String(prNumber);
    const prState = this.state.prs[key] ?? defaultPullRequestState();
    prState.commentBatchHistory = takeLatest(
      [...prState.commentBatchHistory, entry],
      this.limits.commentBatchHistoryLimit,
    );
    this.state.prs[key] = prState;
    this.persist();
  }

  getPostedReviewFindingKeys(prNumber: number): string[] {
    return this.state.prs[String(prNumber)]?.postedReviewFindingKeys ?? [];
  }

  recordReviewRun(args: {
    prNumber: number;
    entry: PRReviewRunHistory;
    postedFindingKeys: string[];
  }): void {
    const key = String(args.prNumber);
    const prState = this.state.prs[key] ?? defaultPullRequestState();
    prState.reviewRunHistory = takeLatest(
      [...prState.reviewRunHistory, args.entry],
      this.limits.commentBatchHistoryLimit,
    );
    if (args.postedFindingKeys.length > 0) {
      const seen = new Set(prState.postedReviewFindingKeys);
      for (const findingKey of args.postedFindingKeys) {
        seen.add(findingKey);
      }
      prState.postedReviewFindingKeys = takeLatest(
        [...seen],
        this.limits.processedCommentKeyLimit,
      );
    }
    this.state.prs[key] = prState;
    this.persist();
  }

  private getPrState(prNumber: number): GitHubPullRequestState {
    const key = String(prNumber);
    const prState = this.state.prs[key] ?? defaultPullRequestState();
    this.state.prs[key] = prState;
    return prState;
  }

  private markCommentsProcessed(keys: string[]): void {
    const seen = new Set(this.state.processedCommentKeys);
    for (const key of keys) {
      seen.add(key);
    }
    this.state.processedCommentKeys = takeLatest(
      [...seen],
      this.limits.processedCommentKeyLimit,
    );
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      log.debug("no github repo state file yet, starting fresh", { file: this.file });
      return;
    }
    try {
      this.state = normalizeState(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (err) {
      log.warn("failed to parse github repo state file, resetting", {
        file: this.file,
        error: String(err),
      });
      this.state = defaultState();
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

function takeLatest<T>(items: T[], limit: number): T[] {
  return limit <= 0 ? [] : items.slice(-limit);
}

function defaultPullRequestState(): GitHubPullRequestState {
  return {
    cursors: {
      issueCommentId: 0,
      reviewCommentId: 0,
    },
    commentBatchHistory: [],
    reviewRunHistory: [],
    postedReviewFindingKeys: [],
  };
}

function normalizeState(raw: unknown): GitHubRepoState {
  const state = raw as Partial<GitHubRepoState>;
  const prs: Record<string, GitHubPullRequestState> = {};
  for (const [prNumber, prState] of Object.entries(state.prs ?? {})) {
    const inferredCursors = inferCursorsFromHistory(prState.commentBatchHistory ?? []);
    prs[prNumber] = {
      cursors: {
        issueCommentId: prState.cursors?.issueCommentId ?? inferredCursors.issueCommentId,
        reviewCommentId: prState.cursors?.reviewCommentId ?? inferredCursors.reviewCommentId,
      },
      commentBatchHistory: prState.commentBatchHistory ?? [],
      reviewRunHistory: prState.reviewRunHistory ?? [],
      postedReviewFindingKeys: prState.postedReviewFindingKeys ?? [],
    };
  }
  return {
    cursors: {
      issueCommentId: state.cursors?.issueCommentId ?? 0,
      reviewCommentId: state.cursors?.reviewCommentId ?? 0,
    },
    pendingCommentGroups: state.pendingCommentGroups ?? {},
    processedCommentKeys: state.processedCommentKeys ?? [],
    prs,
  };
}

function inferCursorsFromHistory(history: PRCommentBatchHistory[]): GitHubRepoCursors {
  const cursors = { issueCommentId: 0, reviewCommentId: 0 };
  for (const entry of history) {
    for (const key of entry.commentKeys) {
      const match = /:(issue|review):([0-9]+)$/.exec(key);
      if (!match) continue;
      const id = Number(match[2]);
      if (match[1] === "issue") {
        cursors.issueCommentId = Math.max(cursors.issueCommentId, id);
      } else {
        cursors.reviewCommentId = Math.max(cursors.reviewCommentId, id);
      }
    }
  }
  return cursors;
}
