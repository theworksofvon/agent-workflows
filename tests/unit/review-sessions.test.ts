import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import {
  SESSION_MAX_AGE_MS,
  SESSIONS_KEPT_PER_PR,
  sqliteReviewSessions,
  type ReviewSessionStore,
} from "../../src/adapters/state/review-sessions.js";

const repo = { owner: "acme", repo: "widgets" };

function setup(): {
  root: string;
  db: DatabaseSync;
  store: ReviewSessionStore;
  tick: () => void;
  close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "review-sessions-"));
  const db = openStateDatabase(join(root, "state"));
  let ms = Date.UTC(2026, 0, 1);
  const store = sqliteReviewSessions(db, () => new Date(ms));
  return {
    root,
    db,
    store,
    tick: () => {
      ms += 1_000;
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("create initializes a queued session and get returns it", () => {
  const s = setup();
  try {
    const created = s.store.create({
      repo,
      prNumber: 7,
      agent: "claude",
      account: "alice",
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.status, "queued");
    assert.equal(created.stage, "Queued");
    assert.equal(created.error, null);
    assert.equal(created.pr, null);
    assert.equal(created.triage, null);
    assert.deepEqual(created.guide, { value: null, error: null });
    assert.deepEqual(created.review, {
      value: null,
      error: null,
      adversarial: false,
    });
    assert.equal(created.publishedAt, null);
    assert.equal(created.createdAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(s.store.get(created.id), created);
    assert.equal(s.store.get("missing"), null);
  } finally {
    s.close();
  }
});

test("list returns newest updatedAt first and honors the limit", () => {
  const s = setup();
  try {
    const a = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    s.tick();
    const b = s.store.create({
      repo,
      prNumber: 2,
      agent: "claude",
      account: "alice",
    });
    s.tick();
    const c = s.store.create({
      repo,
      prNumber: 3,
      agent: "claude",
      account: "alice",
    });
    s.tick();
    s.store.update(a.id, { stage: "Again" });
    assert.deepEqual(
      s.store.list(10).map((x) => x.id),
      [a.id, c.id, b.id],
    );
    assert.equal(s.store.list(2).length, 2);
  } finally {
    s.close();
  }
});

test("update merges the patch and bumps updatedAt", () => {
  const s = setup();
  try {
    const created = s.store.create({
      repo,
      prNumber: 7,
      agent: "claude",
      account: "alice",
    });
    s.tick();
    const updated = s.store.update(created.id, {
      status: "failed",
      stage: "Done",
      error: "boom",
      publishedAt: "2026-02-01T00:00:00.000Z",
    });
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "boom");
    assert.equal(updated.prNumber, 7);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-01-01T00:00:01.000Z");
    assert.deepEqual(s.store.get(created.id), updated);
  } finally {
    s.close();
  }
});

test("update throws for a missing session", () => {
  const s = setup();
  try {
    assert.throws(
      () => s.store.update("missing", { stage: "x" }),
      /review session not found: missing/,
    );
  } finally {
    s.close();
  }
});

test("chapter and file marks toggle on and off", () => {
  const s = setup();
  try {
    const { id } = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    assert.deepEqual(s.store.human(id), {
      chapters: {},
      files: {},
      verdicts: {},
      comments: [],
    });
    s.store.setChapterReviewed(id, "c1", true);
    s.store.setChapterReviewed(id, "c1", true);
    s.store.setFileViewed(id, "a.ts", true);
    s.store.setFileViewed(id, "b.ts", true);
    assert.deepEqual(s.store.human(id).chapters, { c1: true });
    assert.deepEqual(s.store.human(id).files, { "a.ts": true, "b.ts": true });
    s.store.setChapterReviewed(id, "c1", false);
    s.store.setFileViewed(id, "a.ts", false);
    assert.deepEqual(s.store.human(id).chapters, {});
    assert.deepEqual(s.store.human(id).files, { "b.ts": true });
  } finally {
    s.close();
  }
});

test("verdicts are set, replaced, and cleared with null", () => {
  const s = setup();
  try {
    const { id } = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    s.store.setVerdict(id, "f1", "agree", "yes");
    s.tick();
    s.store.setVerdict(id, "f1", "disagree", "no");
    s.store.setVerdict(id, "f2", "unsure", "");
    assert.deepEqual(s.store.human(id).verdicts, {
      f1: {
        verdict: "disagree",
        note: "no",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      f2: {
        verdict: "unsure",
        note: "",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    s.store.setVerdict(id, "f1", null, "");
    assert.deepEqual(Object.keys(s.store.human(id).verdicts), ["f2"]);
  } finally {
    s.close();
  }
});

test("comments are added in order and deleted by id", () => {
  const s = setup();
  try {
    const { id } = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    const other = s.store.create({
      repo,
      prNumber: 2,
      agent: "claude",
      account: "alice",
    });
    const first = s.store.addComment(id, { path: "a.ts", line: 3, body: "x" });
    s.tick();
    const second = s.store.addComment(id, { path: "b.ts", line: 9, body: "y" });
    assert.notEqual(first.id, second.id);
    assert.deepEqual(s.store.human(id).comments, [first, second]);
    assert.deepEqual(s.store.human(other.id).comments, []);
    assert.equal(s.store.deleteComment(id, "nope"), false);
    assert.equal(s.store.deleteComment(other.id, first.id), false);
    assert.equal(s.store.deleteComment(id, first.id), true);
    assert.deepEqual(s.store.human(id).comments, [second]);
  } finally {
    s.close();
  }
});

test("failInterrupted fails only in-progress sessions", () => {
  const s = setup();
  try {
    const ids = (["queued", "triaging", "preparing", "analyzing"] as const).map(
      (status, i) => {
        const x = s.store.create({
          repo,
          prNumber: i,
          agent: "claude",
          account: "alice",
        });
        s.store.update(x.id, { status });
        return x.id;
      },
    );
    const ready = s.store.create({
      repo,
      prNumber: 10,
      agent: "claude",
      account: "alice",
    });
    s.store.update(ready.id, { status: "ready" });
    const failed = s.store.create({
      repo,
      prNumber: 11,
      agent: "claude",
      account: "alice",
    });
    s.store.update(failed.id, { status: "failed", error: "earlier" });
    s.tick();

    assert.equal(s.store.failInterrupted(), 4);
    for (const id of ids) {
      const x = s.store.get(id);
      assert.equal(x?.status, "failed");
      assert.equal(x?.stage, "Interrupted");
      assert.equal(x?.error, "interrupted: the server stopped during this run");
      assert.equal(x?.updatedAt, "2026-01-01T00:00:01.000Z");
    }
    assert.equal(s.store.get(ready.id)?.status, "ready");
    assert.equal(s.store.get(failed.id)?.error, "earlier");
    assert.equal(s.store.failInterrupted(), 0);
  } finally {
    s.close();
  }
});

test("prune keeps each PR's newest sessions and drops old finished ones with their human state", () => {
  const s = setup();
  try {
    let ms = Date.UTC(2026, 0, 1);
    const store = sqliteReviewSessions(s.db, () => new Date(ms));
    const make = (prNumber: number, status: "ready" | "failed" | "queued") => {
      ms += 1_000;
      const { id } = store.create({
        repo,
        prNumber,
        agent: "claude",
        account: "alice",
      });
      store.setChapterReviewed(id, "c1", true);
      store.setVerdict(id, "f1", "agree", "ok");
      store.addComment(id, { path: "a.ts", line: 1, body: "b" });
      // Published, so its human state is on GitHub and may go.
      store.update(id, { status, publishedAt: new Date(ms).toISOString() });
      return id;
    };
    // Older than the age limit: PR 2's finished and running sessions, and
    // PR 3's only session.
    const oldFailed = make(2, "failed");
    const oldRunning = make(2, "queued");
    const lone = make(3, "ready");
    ms += SESSION_MAX_AGE_MS;
    // Recent: two more than the per-PR count on PR 1, and PR 2's newest.
    const pr1 = Array.from({ length: SESSIONS_KEPT_PER_PR + 2 }, () =>
      make(1, "ready"),
    );
    const pr2Newest = make(2, "ready");

    assert.equal(store.prune(), 3);
    for (const id of [pr1[0], pr1[1], oldFailed]) {
      assert.equal(store.get(id), null);
      assert.deepEqual(store.human(id), {
        chapters: {},
        files: {},
        verdicts: {},
        comments: [],
      });
    }
    for (const id of [...pr1.slice(2), pr2Newest, oldRunning, lone])
      assert.notEqual(store.get(id), null);
    assert.equal(store.human(lone).comments.length, 1);
    assert.equal(store.prune(), 0);
  } finally {
    s.close();
  }
});

test("prune keeps an old session with unpublished marks, verdicts, or comments", () => {
  const s = setup();
  try {
    let ms = Date.UTC(2026, 0, 1);
    const store = sqliteReviewSessions(s.db, () => new Date(ms));
    const make = (edit: (id: string) => void) => {
      ms += 1_000;
      const { id } = store.create({
        repo,
        prNumber: 1,
        agent: "claude",
        account: "alice",
      });
      store.update(id, { status: "ready" });
      edit(id);
      return id;
    };
    const untouched = make(() => {});
    const marked = make((id) => store.setFileViewed(id, "a.ts", true));
    const judged = make((id) => store.setVerdict(id, "f1", "unsure", ""));
    const commented = make((id) =>
      store.addComment(id, { path: "a.ts", line: 1, body: "b" }),
    );
    make(() => {});
    ms += SESSION_MAX_AGE_MS + 1_000;

    assert.equal(store.prune(), 1);
    assert.equal(store.get(untouched), null);
    for (const id of [marked, judged, commented])
      assert.notEqual(store.get(id), null);
  } finally {
    s.close();
  }
});

test("a human edit bumps the session's updatedAt", () => {
  const s = setup();
  try {
    const { id, updatedAt } = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    const edits = [
      () => s.store.setChapterReviewed(id, "c1", true),
      () => s.store.setFileViewed(id, "a.ts", false),
      () => s.store.setVerdict(id, "f1", "agree", ""),
      () => s.store.setVerdict(id, "f1", null, ""),
      () => s.store.addComment(id, { path: "a.ts", line: 1, body: "b" }),
      () => s.store.deleteComment(id, "missing"),
    ];
    let last = updatedAt;
    for (const edit of edits) {
      s.tick();
      edit();
      const now = s.store.get(id)!.updatedAt;
      assert.ok(now > last);
      assert.equal(s.store.list(1)[0].updatedAt, now);
      last = now;
    }
  } finally {
    s.close();
  }
});

test("reopening the database keeps sessions and human state", () => {
  const s = setup();
  try {
    const { id } = s.store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    s.store.setChapterReviewed(id, "c1", true);
    s.store.setVerdict(id, "f1", "agree", "ok");
    const c = s.store.addComment(id, { path: "a.ts", line: 1, body: "b" });
    s.db.close();
    const db2 = openStateDatabase(join(s.root, "state"));
    try {
      const store2 = sqliteReviewSessions(db2);
      assert.equal(store2.get(id)?.prNumber, 1);
      const human = store2.human(id);
      assert.deepEqual(human.chapters, { c1: true });
      assert.equal(human.verdicts.f1?.verdict, "agree");
      assert.deepEqual(human.comments, [c]);
    } finally {
      db2.close();
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("the store stamps with the system clock by default", () => {
  const s = setup();
  try {
    const store = sqliteReviewSessions(s.db);
    const before = Date.now();
    const created = store.create({
      repo,
      prNumber: 1,
      agent: "claude",
      account: "alice",
    });
    assert.ok(Date.parse(created.createdAt) >= before);
  } finally {
    s.close();
  }
});

test("latestId names a PR's newest session", () => {
  const s = setup();
  try {
    assert.equal(s.store.latestId(repo, 7), null);
    const first = s.store.create({
      repo,
      prNumber: 7,
      agent: "a",
      account: "x",
    });
    s.tick();
    const second = s.store.create({
      repo,
      prNumber: 7,
      agent: "a",
      account: "x",
    });
    s.tick();
    s.store.update(first.id, { stage: "touched" });
    s.store.create({ repo, prNumber: 8, agent: "a", account: "x" });
    assert.equal(s.store.latestId(repo, 7), second.id);
    assert.equal(s.store.latestId({ owner: "acme", repo: "other" }, 7), null);
  } finally {
    s.close();
  }
});

test("a session stored before accounts reads with safe values until it adopts one", () => {
  const s = setup();
  try {
    const current = s.store.create({
      repo,
      prNumber: 1,
      agent: "a",
      account: "bob",
    });
    const legacy = {
      id: "legacy",
      repo,
      prNumber: 2,
      status: "ready",
      stage: "Ready",
      error: null,
      createdAt: "2025-12-01T00:00:00.000Z",
      updatedAt: "2025-12-01T00:00:00.000Z",
      agent: "a",
      pr: {
        title: "Old",
        body: null,
        author: "octocat",
        url: "https://github.com/acme/widgets/pull/2",
        headRef: "h",
        baseRef: "main",
        headSha: "abc",
        files: [],
      },
      triage: null,
      guide: { value: null, error: null },
      review: { value: null, error: null, adversarial: false },
      publishedAt: null,
    };
    s.db
      .prepare(
        `INSERT INTO review_sessions
           (id, owner, name, pr_number, status, created_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacy.id,
        repo.owner,
        repo.repo,
        2,
        "ready",
        legacy.createdAt,
        legacy.updatedAt,
        JSON.stringify(legacy),
      );
    const read = s.store.get("legacy");
    assert.equal(read?.account, "");
    assert.equal(read?.pr?.authorAvatarUrl, null);
    assert.equal(read?.pr?.state, "open");
    assert.equal(read?.pr?.lastCommit, null);

    assert.equal(s.store.adoptAccount("alice"), 1);
    assert.equal(s.store.get("legacy")?.account, "alice");
    assert.equal(s.store.get(current.id)?.account, "bob");
    assert.equal(s.store.adoptAccount("carol"), 0);
  } finally {
    s.close();
  }
});
