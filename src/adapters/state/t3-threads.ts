import type { DatabaseSync } from "node:sqlite";

/** The T3 thread of one account's review of one PR. */
export interface T3ThreadRow {
  /** `account:owner/repo#number`. */
  key: string;
  threadId: string;
  /** T3's Markdown link to the thread. */
  link: string;
  /** Null for a scratch thread. */
  projectId: string | null;
  /** The newest session that the thread was told about. */
  sessionId: string;
  createdAt: string;
}

export interface T3ThreadStore {
  get(key: string): T3ThreadRow | null;
  save(row: T3ThreadRow): void;
}

export function sqliteT3Threads(db: DatabaseSync): T3ThreadStore {
  return {
    get(key) {
      const row = db
        .prepare("SELECT * FROM t3_threads WHERE thread_key = ?")
        .get(key);
      if (!row) return null;
      return {
        key,
        threadId: row.thread_id as string,
        link: row.link as string,
        projectId: (row.project_id as string | null) ?? null,
        sessionId: row.session_id as string,
        createdAt: row.created_at as string,
      };
    },
    save(row) {
      db.prepare(
        `INSERT INTO t3_threads (thread_key, thread_id, link, project_id, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_key) DO UPDATE SET
           thread_id = excluded.thread_id, link = excluded.link,
           project_id = excluded.project_id, session_id = excluded.session_id,
           created_at = excluded.created_at`,
      ).run(
        row.key,
        row.threadId,
        row.link,
        row.projectId,
        row.sessionId,
        row.createdAt,
      );
    },
  };
}
