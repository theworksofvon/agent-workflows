import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../../config.js";
import type { RepoRef } from "../../domain/pull-request.js";
import type { RepoStatePort, StateFactory } from "./state.interface.js";

/** Posted review findings kept per PR. */
export const POSTED_FINDING_LIMIT = 2000;

export const STATE_DATABASE_FILE = "agent-workflows.sqlite";

// The DROP statements remove the tables of the retired feedback bot and of
// older review runs from databases that an earlier version created.
const SCHEMA = `
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS pr_cursors;
DROP TABLE IF EXISTS comment_groups;
DROP TABLE IF EXISTS processed_comments;
DROP TABLE IF EXISTS seen_deliveries;
DROP TABLE IF EXISTS pr_batch_history;
DROP TABLE IF EXISTS pr_review_runs;
CREATE TABLE IF NOT EXISTS posted_review_findings (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  key TEXT NOT NULL,
  UNIQUE (owner, name, pr_number, key)
);
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_sessions_updated
  ON review_sessions (updated_at);
CREATE TABLE IF NOT EXISTS review_marks (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chapter', 'file')),
  key TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, key)
);
CREATE TABLE IF NOT EXISTS review_verdicts (
  session_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, finding_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Opens (creating if needed) the app's state database under stateDir. */
export function openStateDatabase(stateDir: string): DatabaseSync {
  mkdirSync(stateDir, { recursive: true });
  // The timeout lets a `review` CLI run and the app wait on each other's
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
 * The review findings posted to each PR, in a shared SQLite database. Every
 * row is keyed by (owner, name), so repos never see each other's findings.
 */
export class SqliteRepoStateStore implements RepoStatePort {
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly db: DatabaseSync,
    repo: RepoRef,
    private readonly limit: number = POSTED_FINDING_LIMIT,
  ) {
    this.owner = repo.owner;
    this.name = repo.repo;
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

  recordPostedFindings(prNumber: number, keys: string[]): void {
    if (keys.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of keys) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO posted_review_findings (owner, name, pr_number, key)
             VALUES (?, ?, ?, ?)`,
          )
          .run(this.owner, this.name, prNumber, key);
      }
      // Keeps the newest `limit` rows for this PR; a limit of 0 keeps none.
      this.db
        .prepare(
          `DELETE FROM posted_review_findings
           WHERE owner = ? AND name = ? AND pr_number = ? AND seq NOT IN (
             SELECT seq FROM posted_review_findings
             WHERE owner = ? AND name = ? AND pr_number = ?
             ORDER BY seq DESC LIMIT ?)`,
        )
        .run(
          this.owner,
          this.name,
          prNumber,
          this.owner,
          this.name,
          prNumber,
          Math.max(0, this.limit),
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** One database connection per factory, one store per repo. */
export const sqliteState = (
  config: Config,
  options: { db?: DatabaseSync } = {},
): StateFactory => {
  const db = options.db ?? openStateDatabase(config.stateDir);
  const stores = new Map<string, SqliteRepoStateStore>();
  return (repo) => {
    const key = `${repo.owner}/${repo.repo}`;
    let store = stores.get(key);
    if (!store) {
      store = new SqliteRepoStateStore(db, repo);
      stores.set(key, store);
    }
    return store;
  };
};
