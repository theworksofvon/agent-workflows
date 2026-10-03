import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

interface PendingCommentGroup extends CommentBatch {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  retryAfterMs?: number;
  lastError?: string;
}

export interface StateOptions {
  /**
   * Requeue batches a previous process left in flight. Only the daemon may set
   * this: a one-off command running beside a live daemon would otherwise
   * requeue the daemon's running batch and handle it twice.
   */
  recoverInFlight?: boolean;
}

type GroupStatus = "pending" | "in_flight";
type CursorColumn = "issue_comment_id" | "review_comment_id";

export const STATE_DATABASE_FILE = "agent-workflows.sqlite";

// comment_groups keeps an autoincrement seq so batches come out in the order
// their group was first queued, and an upsert keeps a group's place in line.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  polling_initialized INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, name)
);
CREATE TABLE IF NOT EXISTS pr_cursors (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  issue_comment_id INTEGER NOT NULL DEFAULT 0,
  review_comment_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, name, pr_number)
);
CREATE TABLE IF NOT EXISTS comment_groups (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  group_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight')),
  payload TEXT NOT NULL,
  UNIQUE (owner, name, group_key, status)
);
CREATE TABLE IF NOT EXISTS processed_comments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  UNIQUE (owner, name, key)
);
CREATE TABLE IF NOT EXISTS seen_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  UNIQUE (owner, name, id)
);
CREATE TABLE IF NOT EXISTS pr_batch_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_batch_history_pr
  ON pr_batch_history (owner, name, pr_number, seq);
CREATE TABLE IF NOT EXISTS pr_review_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_review_runs_pr
  ON pr_review_runs (owner, name, pr_number, seq);
CREATE TABLE IF NOT EXISTS posted_review_findings (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  key TEXT NOT NULL,
  UNIQUE (owner, name, pr_number, key)
);
`;

/** Opens (creating if needed) the daemon's state database under stateDir. */
export function openStateDatabase(stateDir: string): DatabaseSync {
  mkdirSync(stateDir, { recursive: true });
  // The timeout lets a `review` CLI run and the daemon wait on each other's
  // write lock instead of failing with SQLITE_BUSY.
  const db = new DatabaseSync(join(stateDir, STATE_DATABASE_FILE), {
    timeout: 5_000,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

/**
 * Typed, per-repository GitHub state in a shared SQLite database. Every row is
 * keyed by (owner, name), so repos never see each other's state.
 */
export class SqliteRepoStateStore implements RepoStatePort {
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly repo: RepoSpec,
    private readonly limits: {
      processedCommentKeyLimit: number;
      commentBatchHistoryLimit: number;
    },
    options: StateOptions = {},
  ) {
    this.owner = repo.owner;
    this.name = repo.repo;
    if (options.recoverInFlight) this.restoreInFlight();
  }

  isPollingInitialized(): boolean {
    const row = this.db
      .prepare(
        "SELECT polling_initialized FROM repos WHERE owner = ? AND name = ?",
      )
      .get(this.owner, this.name);
    return row?.polling_initialized === 1;
  }

  markPollingInitialized(): void {
    this.db
      .prepare(
        `INSERT INTO repos (owner, name, polling_initialized) VALUES (?, ?, 1)
         ON CONFLICT (owner, name) DO UPDATE SET polling_initialized = 1`,
      )
      .run(this.owner, this.name);
  }

  getIssueCommentCursor(prNumber: number): number {
    return this.getCursor(prNumber, "issue_comment_id");
  }

  setIssueCommentCursor(prNumber: number, id: number): void {
    this.setCursor(prNumber, "issue_comment_id", id);
  }

  getReviewCommentCursor(prNumber: number): number {
    return this.getCursor(prNumber, "review_comment_id");
  }

  setReviewCommentCursor(prNumber: number, id: number): void {
    this.setCursor(prNumber, "review_comment_id", id);
  }

  hasProcessedComment(key: string): boolean {
    return this.exists(
      "SELECT 1 FROM processed_comments WHERE owner = ? AND name = ? AND key = ?",
      key,
    );
  }

  addPendingComment(args: {
    groupKey: string;
    pr: PullRequest;
    comment: Comment;
    now: number;
  }): void {
    const { groupKey, pr, comment, now } = args;
    this.transaction(() => {
      const existing = this.getGroup(groupKey, "pending");
      const comments = existing?.comments ?? [];
      if (comments.some((c) => c.key === comment.key)) return;
      // Poll re-reads comments a webhook already delivered; one that is still
      // running must not start a second batch.
      const inFlight = this.getGroup(groupKey, "in_flight");
      if (inFlight?.comments.some((c) => c.key === comment.key)) return;

      const firstSeenAtMs = existing?.firstSeenAtMs ?? now;
      this.putGroup("pending", {
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
      });
    });
  }

  takeReadyCommentBatches(
    now: number,
    policy: {
      quietWindowMs: number;
      minComments: number;
      maxWaitMs: number;
    },
  ): CommentBatch[] {
    return this.transaction(() => {
      const ready: CommentBatch[] = [];
      for (const group of this.listGroups("pending")) {
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
        // Kept until completed or paused so a crash mid-run restores it.
        this.putGroup("in_flight", group);
        this.deleteGroup(group.groupKey, "pending");
      }
      return ready;
    });
  }

  markBatchCompleted(batch: CommentBatch): void {
    this.transaction(() => {
      this.deleteGroup(batch.groupKey, "in_flight");
      for (const comment of batch.comments) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO processed_comments (owner, name, key) VALUES (?, ?, ?)",
          )
          .run(this.owner, this.name, comment.key);
      }
      this.trimRepoRows(
        "processed_comments",
        this.limits.processedCommentKeyLimit,
      );
    });
  }

  pauseBatchForRetry(args: {
    batch: CommentBatch;
    retryAfterMs: number;
    error: string;
  }): void {
    const { batch, retryAfterMs, error } = args;
    this.transaction(() => {
      this.deleteGroup(batch.groupKey, "in_flight");
      // Comments that arrived while the batch ran sit in a new pending group
      // under the same key; the paused batch must join them, not replace them.
      const newer = this.getGroup(batch.groupKey, "pending");
      const merged = mergeComments(batch.comments, newer?.comments ?? []);
      const firstSeenAtMs = Number(new Date(batch.firstSeenAt));
      const lastSeenAtMs = Math.max(
        Number(new Date(batch.lastSeenAt)),
        newer?.lastSeenAtMs ?? 0,
      );
      this.putGroup("pending", {
        ...batch,
        lastSeenAt: new Date(lastSeenAtMs).toISOString(),
        comments: merged,
        firstSeenAtMs,
        lastSeenAtMs,
        retryAfterMs,
        lastError: error,
      });
    });
  }

  getRecentPrHistory(prNumber: number, limit: number): BatchHistory[] {
    return this.recentPrPayloads<BatchHistory>(
      "pr_batch_history",
      prNumber,
      limit,
    );
  }

  recordPrHistory(prNumber: number, entry: BatchHistory): void {
    this.transaction(() => {
      this.appendPrPayload("pr_batch_history", prNumber, entry);
    });
  }

  getPostedReviewFindingKeys(prNumber: number): string[] {
    return this.db
      .prepare(
        `SELECT key FROM posted_review_findings
         WHERE owner = ? AND name = ? AND pr_number = ? ORDER BY seq`,
      )
      .all(this.owner, this.name, prNumber)
      .map((row) => row.key as string);
  }

  recordReviewRun(args: {
    prNumber: number;
    entry: ReviewRunHistory;
    postedFindingKeys: string[];
  }): void {
    const { prNumber, entry, postedFindingKeys } = args;
    this.transaction(() => {
      this.appendPrPayload("pr_review_runs", prNumber, entry);
      if (postedFindingKeys.length === 0) return;
      for (const key of postedFindingKeys) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO posted_review_findings (owner, name, pr_number, key)
             VALUES (?, ?, ?, ?)`,
          )
          .run(this.owner, this.name, prNumber, key);
      }
      this.trimPrRows(
        "posted_review_findings",
        prNumber,
        this.limits.processedCommentKeyLimit,
      );
    });
  }

  hasSeenDelivery(id: string): boolean {
    return this.exists(
      "SELECT 1 FROM seen_deliveries WHERE owner = ? AND name = ? AND id = ?",
      id,
    );
  }

  markDeliverySeen(id: string): void {
    this.transaction(() => {
      const { changes } = this.db
        .prepare(
          "INSERT OR IGNORE INTO seen_deliveries (owner, name, id) VALUES (?, ?, ?)",
        )
        .run(this.owner, this.name, id);
      if (changes === 0) return;
      this.trimRepoRows(
        "seen_deliveries",
        this.limits.processedCommentKeyLimit,
      );
    });
  }

  /** The previous process died or was stopped mid-run; queue those again. */
  private restoreInFlight(): void {
    const count = this.transaction(() => {
      const groups = this.listGroups("in_flight");
      for (const group of groups) {
        const newer = this.getGroup(group.groupKey, "pending");
        this.putGroup(
          "pending",
          newer
            ? {
                ...group,
                comments: mergeComments(group.comments, newer.comments),
                lastSeenAt: newer.lastSeenAt,
                lastSeenAtMs: newer.lastSeenAtMs,
              }
            : group,
        );
        this.deleteGroup(group.groupKey, "in_flight");
      }
      return groups.length;
    });
    if (count === 0) return;
    log.warn("restored in-flight comment batches from a previous run", {
      repo: `${this.owner}/${this.name}`,
      count,
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private exists(sql: string, value: string): boolean {
    return this.db.prepare(sql).get(this.owner, this.name, value) !== undefined;
  }

  private getCursor(prNumber: number, column: CursorColumn): number {
    const row = this.db
      .prepare(
        `SELECT ${column} AS id FROM pr_cursors
         WHERE owner = ? AND name = ? AND pr_number = ?`,
      )
      .get(this.owner, this.name, prNumber);
    return (row?.id as number | undefined) ?? 0;
  }

  private setCursor(prNumber: number, column: CursorColumn, id: number): void {
    this.db
      .prepare(
        `INSERT INTO pr_cursors (owner, name, pr_number, ${column}) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner, name, pr_number) DO UPDATE SET ${column} = excluded.${column}`,
      )
      .run(this.owner, this.name, prNumber, id);
  }

  private getGroup(
    groupKey: string,
    status: GroupStatus,
  ): PendingCommentGroup | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM comment_groups
         WHERE owner = ? AND name = ? AND group_key = ? AND status = ?`,
      )
      .get(this.owner, this.name, groupKey, status);
    return row && (JSON.parse(row.payload as string) as PendingCommentGroup);
  }

  private listGroups(status: GroupStatus): PendingCommentGroup[] {
    return this.db
      .prepare(
        `SELECT payload FROM comment_groups
         WHERE owner = ? AND name = ? AND status = ? ORDER BY seq`,
      )
      .all(this.owner, this.name, status)
      .map((row) => JSON.parse(row.payload as string) as PendingCommentGroup);
  }

  private putGroup(status: GroupStatus, group: PendingCommentGroup): void {
    this.db
      .prepare(
        `INSERT INTO comment_groups (owner, name, group_key, status, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, name, group_key, status)
         DO UPDATE SET payload = excluded.payload`,
      )
      .run(
        this.owner,
        this.name,
        group.groupKey,
        status,
        JSON.stringify(group),
      );
  }

  private deleteGroup(groupKey: string, status: GroupStatus): void {
    this.db
      .prepare(
        `DELETE FROM comment_groups
         WHERE owner = ? AND name = ? AND group_key = ? AND status = ?`,
      )
      .run(this.owner, this.name, groupKey, status);
  }

  private recentPrPayloads<T>(
    table: "pr_batch_history" | "pr_review_runs",
    prNumber: number,
    limit: number,
  ): T[] {
    return this.db
      .prepare(
        `SELECT payload FROM ${table}
         WHERE owner = ? AND name = ? AND pr_number = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(this.owner, this.name, prNumber, Math.max(0, limit))
      .map((row) => JSON.parse(row.payload as string) as T)
      .reverse();
  }

  private appendPrPayload(
    table: "pr_batch_history" | "pr_review_runs",
    prNumber: number,
    entry: BatchHistory | ReviewRunHistory,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (owner, name, pr_number, payload) VALUES (?, ?, ?, ?)`,
      )
      .run(this.owner, this.name, prNumber, JSON.stringify(entry));
    this.trimPrRows(table, prNumber, this.limits.commentBatchHistoryLimit);
  }

  /** Keeps the newest `limit` rows for this repo; a limit of 0 keeps none. */
  private trimRepoRows(
    table: "processed_comments" | "seen_deliveries",
    limit: number,
  ): void {
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE owner = ? AND name = ? AND seq NOT IN (
           SELECT seq FROM ${table} WHERE owner = ? AND name = ?
           ORDER BY seq DESC LIMIT ?)`,
      )
      .run(this.owner, this.name, this.owner, this.name, Math.max(0, limit));
  }

  /** Keeps the newest `limit` rows for one PR; a limit of 0 keeps none. */
  private trimPrRows(
    table: "pr_batch_history" | "pr_review_runs" | "posted_review_findings",
    prNumber: number,
    limit: number,
  ): void {
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE owner = ? AND name = ? AND pr_number = ?
         AND seq NOT IN (
           SELECT seq FROM ${table} WHERE owner = ? AND name = ? AND pr_number = ?
           ORDER BY seq DESC LIMIT ?)`,
      )
      .run(
        this.owner,
        this.name,
        prNumber,
        this.owner,
        this.name,
        prNumber,
        Math.max(0, limit),
      );
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

/**
 * One database connection per factory, one store per repo. Memoizing the
 * store means in-flight batches are restored at most once, when a repo is
 * first used.
 */
export const sqliteState = (
  config: Config,
  options: StateOptions = {},
): StateFactory => {
  const db = openStateDatabase(config.stateDir);
  const limits = {
    processedCommentKeyLimit: config.processedCommentKeyLimit,
    commentBatchHistoryLimit: config.commentBatchHistoryLimit,
  };
  const stores = new Map<string, SqliteRepoStateStore>();
  return (repo) => {
    const key = `${repo.owner}/${repo.repo}`;
    let store = stores.get(key);
    if (!store) {
      store = new SqliteRepoStateStore(db, repo, limits, options);
      stores.set(key, store);
    }
    return store;
  };
};
