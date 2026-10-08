import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Guide } from "../../domain/guide.js";
import type { ReviewResult } from "../../domain/decisions.js";
import type { PullRequestFile, RepoRef } from "../../domain/pull-request.js";
import type { Triage } from "../../domain/triage.js";
import type { LastCommit, PullState } from "../../domain/inbox.js";

export type SessionStatus =
  "queued" | "triaging" | "preparing" | "analyzing" | "ready" | "failed";

export interface PrSnapshot {
  title: string;
  body: string | null;
  author: string;
  authorAvatarUrl: string | null;
  state: PullState;
  lastCommit: LastCommit | null;
  url: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  files: PullRequestFile[];
}

export interface PartResult<T> {
  value: T | null;
  error: string | null;
}

export interface ReviewSession {
  id: string;
  repo: RepoRef;
  prNumber: number;
  status: SessionStatus;
  stage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  agent: string;
  /** The GitHub login that fetched, cloned, and publishes for this run. */
  account: string;
  pr: PrSnapshot | null;
  triage: Triage | null;
  guide: PartResult<Guide>;
  review: PartResult<ReviewResult> & { adversarial: boolean };
  publishedAt: string | null;
}

export type Verdict = "agree" | "disagree" | "unsure";

export interface FindingVerdict {
  verdict: Verdict;
  note: string;
  updatedAt: string;
}

export interface HumanComment {
  id: string;
  path: string;
  line: number;
  body: string;
  createdAt: string;
}

export interface HumanState {
  chapters: Record<string, boolean>;
  files: Record<string, boolean>;
  verdicts: Record<string, FindingVerdict>;
  comments: HumanComment[];
}

export type SessionPatch = Partial<
  Pick<
    ReviewSession,
    | "status"
    | "stage"
    | "error"
    | "pr"
    | "triage"
    | "guide"
    | "review"
    | "publishedAt"
    | "account"
  >
>;

export interface ReviewSessionStore {
  create(args: {
    repo: RepoRef;
    prNumber: number;
    agent: string;
    account: string;
  }): ReviewSession;
  get(id: string): ReviewSession | null;
  /** The id of the PR's newest session, or null. */
  latestId(repo: RepoRef, prNumber: number): string | null;
  /** Records `login` on sessions stored before sessions had an account. */
  adoptAccount(login: string): number;
  /** Newest updatedAt first. */
  list(limit: number): ReviewSession[];
  /** Bumps updatedAt; throws if the session does not exist. */
  update(id: string, patch: SessionPatch): ReviewSession;
  human(id: string): HumanState;
  setChapterReviewed(id: string, chapterId: string, reviewed: boolean): void;
  setFileViewed(id: string, path: string, viewed: boolean): void;
  /** A null verdict clears the finding's verdict. */
  setVerdict(
    id: string,
    findingId: string,
    verdict: Verdict | null,
    note: string,
  ): void;
  addComment(
    id: string,
    c: { path: string; line: number; body: string },
  ): HumanComment;
  deleteComment(id: string, commentId: string): boolean;
  /** Fails every session that is not ready or failed; returns how many. */
  failInterrupted(): number;
  /**
   * Deletes finished sessions, with their marks, verdicts, and comments,
   * that are past the per-PR count or the age limit, and never a PR's
   * newest session or one with unpublished marks, verdicts, or comments.
   * Human edits bump updatedAt. Returns how many sessions it deleted.
   */
  prune(): number;
}

const INTERRUPTED = "interrupted: the server stopped during this run";

/** Each session stores the full patches, so old ones are not kept forever. */
export const SESSIONS_KEPT_PER_PR = 5;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A session with human work that was never published is never pruned. */
const PRUNABLE = `SELECT id FROM (
    SELECT id, status, updated_at, payload, ROW_NUMBER() OVER (
      PARTITION BY owner, name, pr_number ORDER BY created_at DESC, rowid DESC
    ) AS newest
    FROM review_sessions) AS s
  WHERE newest > 1 AND status IN ('ready', 'failed')
    AND (newest > ? OR updated_at < ?)
    AND NOT (
      json_extract(payload, '$.publishedAt') IS NULL AND (
        EXISTS (SELECT 1 FROM review_marks WHERE session_id = s.id)
        OR EXISTS (SELECT 1 FROM review_verdicts WHERE session_id = s.id)
        OR EXISTS (SELECT 1 FROM review_comments WHERE session_id = s.id)))`;

export function sqliteReviewSessions(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
): ReviewSessionStore {
  const stamp = (): string => now().toISOString();

  const get = (id: string): ReviewSession | null => {
    const row = db
      .prepare("SELECT payload FROM review_sessions WHERE id = ?")
      .get(id);
    return row ? parse(row.payload as string) : null;
  };

  const save = (session: ReviewSession): void => {
    db.prepare(
      `INSERT INTO review_sessions
         (id, owner, name, pr_number, status, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    ).run(
      session.id,
      session.repo.owner,
      session.repo.repo,
      session.prNumber,
      session.status,
      session.createdAt,
      session.updatedAt,
      JSON.stringify(session),
    );
  };

  const update = (id: string, patch: SessionPatch): ReviewSession => {
    const existing = get(id);
    if (!existing) throw new Error(`review session not found: ${id}`);
    const next = { ...existing, ...patch, updatedAt: stamp() };
    save(next);
    return next;
  };

  /** A human edit counts as activity, so the age limit restarts. */
  const touch = (id: string): void => {
    const at = stamp();
    db.prepare(
      `UPDATE review_sessions
       SET updated_at = ?, payload = json_set(payload, '$.updatedAt', ?)
       WHERE id = ?`,
    ).run(at, at, id);
  };

  const setMark = (
    id: string,
    kind: "chapter" | "file",
    key: string,
    on: boolean,
  ): void => {
    touch(id);
    if (on) {
      db.prepare(
        "INSERT OR IGNORE INTO review_marks (session_id, kind, key) VALUES (?, ?, ?)",
      ).run(id, kind, key);
      return;
    }
    db.prepare(
      "DELETE FROM review_marks WHERE session_id = ? AND kind = ? AND key = ?",
    ).run(id, kind, key);
  };

  return {
    create({ repo, prNumber, agent, account }) {
      const at = stamp();
      const session: ReviewSession = {
        id: randomUUID(),
        repo,
        prNumber,
        status: "queued",
        stage: "Queued",
        error: null,
        createdAt: at,
        updatedAt: at,
        agent,
        account,
        pr: null,
        triage: null,
        guide: { value: null, error: null },
        review: { value: null, error: null, adversarial: false },
        publishedAt: null,
      };
      save(session);
      return session;
    },

    get,

    latestId(repo, prNumber) {
      const row = db
        .prepare(
          `SELECT id FROM review_sessions WHERE owner = ? AND name = ? AND pr_number = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(repo.owner, repo.repo, prNumber);
      return row ? (row.id as string) : null;
    },

    adoptAccount(login) {
      const { changes } = db
        .prepare(
          `UPDATE review_sessions SET payload = json_set(payload, '$.account', ?)
           WHERE coalesce(json_extract(payload, '$.account'), '') = ''`,
        )
        .run(login);
      return Number(changes);
    },

    list(limit) {
      return db
        .prepare(
          "SELECT payload FROM review_sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?",
        )
        .all(limit)
        .map((row) => parse(row.payload as string));
    },

    update,

    human(id) {
      const state: HumanState = {
        chapters: {},
        files: {},
        verdicts: {},
        comments: [],
      };
      const marks = db
        .prepare("SELECT kind, key FROM review_marks WHERE session_id = ?")
        .all(id);
      for (const m of marks) {
        const target = m.kind === "chapter" ? state.chapters : state.files;
        target[m.key as string] = true;
      }
      const verdicts = db
        .prepare(
          `SELECT finding_id, verdict, note, updated_at FROM review_verdicts
           WHERE session_id = ?`,
        )
        .all(id);
      for (const v of verdicts) {
        state.verdicts[v.finding_id as string] = {
          verdict: v.verdict as Verdict,
          note: v.note as string,
          updatedAt: v.updated_at as string,
        };
      }
      state.comments = db
        .prepare(
          `SELECT id, path, line, body, created_at FROM review_comments
           WHERE session_id = ? ORDER BY created_at, rowid`,
        )
        .all(id)
        .map((c) => ({
          id: c.id as string,
          path: c.path as string,
          line: c.line as number,
          body: c.body as string,
          createdAt: c.created_at as string,
        }));
      return state;
    },

    setChapterReviewed(id, chapterId, reviewed) {
      setMark(id, "chapter", chapterId, reviewed);
    },

    setFileViewed(id, path, viewed) {
      setMark(id, "file", path, viewed);
    },

    setVerdict(id, findingId, verdict, note) {
      touch(id);
      if (verdict === null) {
        db.prepare(
          "DELETE FROM review_verdicts WHERE session_id = ? AND finding_id = ?",
        ).run(id, findingId);
        return;
      }
      db.prepare(
        `INSERT INTO review_verdicts (session_id, finding_id, verdict, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, finding_id) DO UPDATE SET
           verdict = excluded.verdict,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      ).run(id, findingId, verdict, note, stamp());
    },

    addComment(id, c) {
      const comment: HumanComment = {
        id: randomUUID(),
        path: c.path,
        line: c.line,
        body: c.body,
        createdAt: stamp(),
      };
      touch(id);
      db.prepare(
        `INSERT INTO review_comments (id, session_id, path, line, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        comment.id,
        id,
        comment.path,
        comment.line,
        comment.body,
        comment.createdAt,
      );
      return comment;
    },

    deleteComment(id, commentId) {
      touch(id);
      const { changes } = db
        .prepare("DELETE FROM review_comments WHERE session_id = ? AND id = ?")
        .run(id, commentId);
      return changes > 0;
    },

    failInterrupted() {
      const rows = db
        .prepare(
          "SELECT id FROM review_sessions WHERE status NOT IN ('ready', 'failed')",
        )
        .all();
      for (const row of rows) {
        update(row.id as string, {
          status: "failed",
          stage: "Interrupted",
          error: INTERRUPTED,
        });
      }
      return rows.length;
    },

    prune() {
      const cutoff = new Date(now().getTime() - SESSION_MAX_AGE_MS);
      const args = [SESSIONS_KEPT_PER_PR, cutoff.toISOString()];
      for (const table of [
        "review_marks",
        "review_verdicts",
        "review_comments",
      ])
        db.prepare(
          `DELETE FROM ${table} WHERE session_id IN (${PRUNABLE})`,
        ).run(...args);
      const { changes } = db
        .prepare(`DELETE FROM review_sessions WHERE id IN (${PRUNABLE})`)
        .run(...args);
      return Number(changes);
    },
  };
}

/**
 * Sessions stored before accounts, PR state, and the last commit existed
 * read with safe values; an empty account means the current UI account.
 */
function parse(payload: string): ReviewSession {
  const stored = JSON.parse(payload) as ReviewSession;
  return {
    ...stored,
    account: stored.account ?? "",
    pr: stored.pr && {
      ...stored.pr,
      authorAvatarUrl: stored.pr.authorAvatarUrl ?? null,
      state: stored.pr.state ?? "open",
      lastCommit: stored.pr.lastCommit ?? null,
    },
  };
}
