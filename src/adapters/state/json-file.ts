import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, RepoSpec } from "../../config.js";
import type {
  BatchHistory,
  Comment,
  CommentBatch,
  PullRequest,
} from "../../domain/events.js";
import { log } from "../../log.js";
import type {
  RepoStatePort,
  ReviewRunHistory,
  StateFactory,
} from "./state.interface.js";

export interface GitHubRepoCursors {
  issueCommentId: number;
  reviewCommentId: number;
}

export interface PendingCommentGroup extends CommentBatch {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  retryAfterMs?: number;
  lastError?: string;
}

export interface GitHubPullRequestState {
  cursors: GitHubRepoCursors;
  commentBatchHistory: BatchHistory[];
  reviewRunHistory: PRReviewRunHistory[];
  postedReviewFindingKeys: string[];
}

export interface GitHubRepoState {
  pollingInitialized: boolean;
  cursors: GitHubRepoCursors;
  pendingCommentGroups: Record<string, PendingCommentGroup>;
  /** Taken by a run that has not completed or paused yet. */
  inFlightCommentGroups: Record<string, PendingCommentGroup>;
  processedCommentKeys: string[];
  seenDeliveryIds: string[];
  prs: Record<string, GitHubPullRequestState>;
}

/** Kept so existing importers compile; the type now lives with the port. */
export type PRReviewRunHistory = ReviewRunHistory;

const defaultState = (): GitHubRepoState => ({
  pollingInitialized: false,
  cursors: {
    issueCommentId: 0,
    reviewCommentId: 0,
  },
  pendingCommentGroups: {},
  inFlightCommentGroups: {},
  processedCommentKeys: [],
  seenDeliveryIds: [],
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
export class GitHubRepoStateStore implements RepoStatePort {
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

  isPollingInitialized(): boolean {
    return this.state.pollingInitialized;
  }

  markPollingInitialized(): void {
    if (this.state.pollingInitialized) return;
    this.state.pollingInitialized = true;
    this.persist();
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
    pr: PullRequest;
    comment: Comment;
    now: number;
  }): void {
    const { groupKey, pr, comment, now } = args;
    const existing = this.state.pendingCommentGroups[groupKey];
    const comments = existing?.comments ?? [];
    if (comments.some((c) => c.key === comment.key)) return;
    // Poll re-reads comments a webhook already delivered; one that is still
    // running must not start a second batch.
    const inFlight = this.state.inFlightCommentGroups[groupKey];
    if (inFlight?.comments.some((c) => c.key === comment.key)) return;

    const firstSeenAtMs = existing?.firstSeenAtMs ?? now;
    this.state.pendingCommentGroups[groupKey] = {
      repo: this.repo,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      batchId:
        existing?.batchId ??
        `batch:${this.repo.owner}/${this.repo.repo}:${groupKey}:${now}`,
      groupKey,
      firstSeenAt: new Date(firstSeenAtMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      attempts: existing?.attempts ?? 0,
      firstSeenAtMs,
      lastSeenAtMs: now,
      retryAfterMs: existing?.retryAfterMs,
      lastError: existing?.lastError,
      comments: mergeComments(comments, [comment]),
    };
    this.persist();
  }

  takeReadyCommentBatches(
    now: number,
    policy: {
      quietWindowMs: number;
      minComments: number;
      maxWaitMs: number;
    },
  ): CommentBatch[] {
    const ready: CommentBatch[] = [];
    for (const [groupKey, group] of Object.entries(
      this.state.pendingCommentGroups,
    )) {
      if (group.retryAfterMs !== undefined && now < group.retryAfterMs)
        continue;
      if (now - group.lastSeenAtMs < policy.quietWindowMs) continue;
      const thresholdReached = group.comments.length >= policy.minComments;
      const maximumWaitReached =
        policy.maxWaitMs > 0 && now - group.firstSeenAtMs >= policy.maxWaitMs;
      if (!thresholdReached && !maximumWaitReached) continue;
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
      // Kept on disk until completed or paused so a crash mid-run restores it.
      this.state.inFlightCommentGroups[groupKey] = group;
      delete this.state.pendingCommentGroups[groupKey];
    }

    this.persist();
    return ready;
  }

  markBatchCompleted(batch: CommentBatch): void {
    delete this.state.inFlightCommentGroups[batch.groupKey];
    this.markCommentsProcessed(batch.comments.map((comment) => comment.key));
  }

  pauseBatchForRetry(args: {
    batch: CommentBatch;
    retryAfterMs: number;
    error: string;
  }): void {
    const { batch, retryAfterMs, error } = args;
    delete this.state.inFlightCommentGroups[batch.groupKey];
    // Comments that arrived while the batch ran sit in a new pending group
    // under the same key; the paused batch must join them, not replace them.
    const newer = this.state.pendingCommentGroups[batch.groupKey];
    const merged = mergeComments(batch.comments, newer?.comments ?? []);
    const firstSeenAtMs = Number(new Date(batch.firstSeenAt));
    const lastSeenAtMs = Math.max(
      Number(new Date(batch.lastSeenAt)),
      newer?.lastSeenAtMs ?? 0,
    );
    this.state.pendingCommentGroups[batch.groupKey] = {
      ...batch,
      lastSeenAt: new Date(lastSeenAtMs).toISOString(),
      comments: merged,
      firstSeenAtMs,
      lastSeenAtMs,
      retryAfterMs,
      lastError: error,
    };
    this.persist();
  }

  getRecentPrHistory(prNumber: number, limit: number): BatchHistory[] {
    const history = this.state.prs[String(prNumber)]?.commentBatchHistory ?? [];
    return takeLatest(history, limit);
  }

  recordPrHistory(prNumber: number, entry: BatchHistory): void {
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

  hasSeenDelivery(id: string): boolean {
    return this.state.seenDeliveryIds.includes(id);
  }

  markDeliverySeen(id: string): void {
    if (this.state.seenDeliveryIds.includes(id)) return;
    this.state.seenDeliveryIds = takeLatest(
      [...this.state.seenDeliveryIds, id],
      this.limits.processedCommentKeyLimit,
    );
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
      log.debug("no github repo state file yet, starting fresh", {
        file: this.file,
      });
      return;
    }
    try {
      this.state = normalizeState(JSON.parse(readFileSync(this.file, "utf8")));
      this.restoreInFlight();
    } catch (err) {
      log.warn("failed to parse github repo state file, resetting", {
        file: this.file,
        error: String(err),
      });
      this.state = defaultState();
    }
  }

  /** The previous process died or was stopped mid-run; queue those again. */
  private restoreInFlight(): void {
    const groups = Object.entries(this.state.inFlightCommentGroups);
    if (groups.length === 0) return;
    for (const [groupKey, group] of groups) {
      const newer = this.state.pendingCommentGroups[groupKey];
      this.state.pendingCommentGroups[groupKey] = newer
        ? {
            ...group,
            comments: mergeComments(group.comments, newer.comments),
            lastSeenAt: newer.lastSeenAt,
            lastSeenAtMs: newer.lastSeenAtMs,
          }
        : group;
    }
    this.state.inFlightCommentGroups = {};
    log.warn("restored in-flight comment batches from a previous run", {
      file: this.file,
      count: groups.length,
    });
    this.persist();
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

function mergeComments(left: Comment[], right: Comment[]): Comment[] {
  const byKey = new Map<string, Comment>();
  for (const c of [...left, ...right]) byKey.set(c.key, c);
  return [...byKey.values()].sort((a, b) => {
    const byTime =
      Number(new Date(a.createdAt)) - Number(new Date(b.createdAt));
    return byTime === 0 ? a.id - b.id : byTime;
  });
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
    const inferredCursors = inferCursorsFromHistory(
      prState.commentBatchHistory ?? [],
    );
    prs[prNumber] = {
      cursors: {
        issueCommentId:
          prState.cursors?.issueCommentId ?? inferredCursors.issueCommentId,
        reviewCommentId:
          prState.cursors?.reviewCommentId ?? inferredCursors.reviewCommentId,
      },
      commentBatchHistory: prState.commentBatchHistory ?? [],
      reviewRunHistory: prState.reviewRunHistory ?? [],
      postedReviewFindingKeys: prState.postedReviewFindingKeys ?? [],
    };
  }
  return {
    // State files created before this field existed were already live, so they
    // must not be treated as a brand-new installation and replay old comments.
    pollingInitialized: state.pollingInitialized ?? true,
    cursors: {
      issueCommentId: state.cursors?.issueCommentId ?? 0,
      reviewCommentId: state.cursors?.reviewCommentId ?? 0,
    },
    pendingCommentGroups: state.pendingCommentGroups ?? {},
    inFlightCommentGroups: state.inFlightCommentGroups ?? {},
    processedCommentKeys: state.processedCommentKeys ?? [],
    seenDeliveryIds: state.seenDeliveryIds ?? [],
    prs,
  };
}

function inferCursorsFromHistory(history: BatchHistory[]): GitHubRepoCursors {
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

/**
 * One store per repo per factory. Stores snapshot their file on construction
 * and rewrite it whole on every change, so concurrent lanes must share the
 * same in-memory object or the last writer drops the others' updates.
 */
export const jsonFileState = (config: Config): StateFactory => {
  const stores = new Map<string, GitHubRepoStateStore>();
  return (repo) => {
    const key = `${repo.owner}/${repo.repo}`;
    let store = stores.get(key);
    if (!store) {
      store = GitHubRepoStateStore.fromConfig(config, repo);
      stores.set(key, store);
    }
    return store;
  };
};
