import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import {
  sqliteReviewSessions,
  type PrSnapshot,
  type ReviewSessionStore,
} from "../../src/adapters/state/review-sessions.js";
import { findingId, type ReviewFinding } from "../../src/domain/decisions.js";
import type { Guide } from "../../src/domain/guide.js";
import type { GitHubAccountsPort } from "../../src/adapters/github/accounts.js";
import { sqliteSettings } from "../../src/adapters/state/settings.js";
import {
  githubAccess,
  type AccountClient,
} from "../../src/services/github-access.js";
import { card, fakeAccounts, fakeClient } from "../fakes/github.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  reviewApi,
  type ReviewApi,
} from "../../src/services/review-api.js";

const repo = { owner: "acme", repo: "widgets" };

const PATCH = "@@ -1,2 +1,3 @@\n line one\n+added two\n line three";

const pr: PrSnapshot = {
  title: "Add widgets",
  body: "Adds widgets.",
  author: "octocat",
  authorAvatarUrl: "https://avatars.test/octocat",
  state: "open",
  lastCommit: null,
  url: "https://github.com/acme/widgets/pull/7",
  headRef: "feat/widgets",
  baseRef: "main",
  headSha: "abc123",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: PATCH,
    },
    {
      path: "src/b.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      patch: PATCH,
    },
  ],
};

const guide: Guide = {
  overview: {
    context: "Widgets get a new code path.",
    steps: ["Read a.ts", "Then b.ts"],
    flows: [],
  },
  chapters: [
    {
      id: "core",
      title: "Core change",
      role: "core",
      summary: "The widget path.",
      files: ["src/a.ts"],
    },
    {
      id: "other",
      title: "Other changes",
      role: "supporting",
      summary: "The rest.",
      files: ["src/b.ts"],
    },
  ],
};

const findings: ReviewFinding[] = [
  {
    path: "src/a.ts",
    line: 2,
    body: "Null check missing.\nMore detail.",
    severity: "high",
  },
  { path: "src/b.ts", line: 9, body: "Off the diff.", severity: "low" },
];

interface Harness {
  api: ReviewApi;
  store: ReviewSessionStore;
  started: string[];
  reviews: unknown[];
  /** Every GitHub call as `[method, token, ...args]`. */
  calls: unknown[][];
  readyId: string;
  close(): void;
}

function setup(
  overrides: {
    createPullRequestReview?: AccountClient["createPullRequestReview"];
    client?: Partial<AccountClient>;
    accounts?: GitHubAccountsPort;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "review-api-"));
  const db: DatabaseSync = openStateDatabase(join(root, "state"));
  let ms = Date.UTC(2026, 9, 7);
  const store = sqliteReviewSessions(db, () => new Date((ms += 1000)));
  const started: string[] = [];
  const reviews: unknown[] = [];
  const calls: unknown[][] = [];
  const ready = store.create({
    repo,
    prNumber: 7,
    agent: "claude-code",
    account: "alice",
  });
  store.update(ready.id, {
    status: "ready",
    stage: "Ready",
    pr,
    guide: { value: guide, error: null },
    review: {
      value: { summary: "Two issues.", findings },
      error: null,
      adversarial: false,
    },
  });
  const api = reviewApi({
    sessions: store,
    github: githubAccess({
      accounts: overrides.accounts ?? fakeAccounts(),
      settings: sqliteSettings(db),
      createClient: (token) =>
        fakeClient(token, calls, {
          createPullRequestReview:
            overrides.createPullRequestReview ??
            (async (args) => {
              calls.push(["review", token]);
              reviews.push(args);
            }),
          ...overrides.client,
        }),
    }),
    startRun: async (id) => {
      started.push(id);
    },
    agent: "claude-code",
  });
  return {
    api,
    store,
    started,
    reviews,
    calls,
    readyId: ready.id,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("health reports the agent", async () => {
  const h = setup();
  try {
    assert.deepEqual(h.api.health(), { ok: true, agent: "claude-code" });
  } finally {
    h.close();
  }
});

test("creating a session parses the target, stores it, and starts its run in the background", async () => {
  const h = setup();
  try {
    const { id } = await h.api.createSession({
      target: "https://github.com/acme/widgets/pull/12",
    });
    assert.deepEqual(h.started, [id]);
    const created = h.store.get(id);
    assert.deepEqual(created?.repo, repo);
    assert.equal(created?.prNumber, 12);
    assert.equal(created?.agent, "claude-code");
    assert.equal(created?.status, "queued");
    assert.equal(created?.account, "alice");

    const asBob = await h.api.createSession({
      target: "acme/widgets#13",
      account: "bob",
    });
    assert.equal(h.store.get(asBob.id)?.account, "bob");

    for (const body of [
      { target: "nope" },
      {},
      null,
      "acme/widgets#1",
      { target: "acme/widgets#1", account: 7 },
      { target: "acme/widgets#1", account: "mallory" },
    ]) {
      await assert.rejects(h.api.createSession(body), BadRequestError);
    }
    assert.equal(h.started.length, 2);
  } finally {
    h.close();
  }
});

test("listing sessions summarizes each one newest first with counts", async () => {
  const h = setup();
  try {
    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    const { sessions } = h.api.listSessions();
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], {
      id: queued.id,
      repo,
      prNumber: 3,
      title: null,
      author: null,
      status: "queued",
      stage: "Queued",
      triage: null,
      createdAt: h.store.get(queued.id)?.createdAt,
      updatedAt: h.store.get(queued.id)?.updatedAt,
      counts: { files: 0, findings: 0, chapters: 0 },
      account: "alice",
      authorAvatarUrl: null,
      state: "open",
      reviewedChapters: 0,
    });
    assert.deepEqual(sessions[1].counts, {
      files: 2,
      findings: 2,
      chapters: 2,
    });
    assert.equal(sessions[1].title, "Add widgets");
    assert.equal(sessions[1].author, "octocat");
    assert.equal(sessions[1].authorAvatarUrl, "https://avatars.test/octocat");

    // Only marks on chapters the guide still has count as reviewed.
    h.store.setChapterReviewed(h.readyId, "core", true);
    h.store.setChapterReviewed(h.readyId, "gone", true);
    // The mark is a human edit, so the ready session now lists first.
    assert.equal(h.api.listSessions().sessions[0].id, h.readyId);
    assert.equal(h.api.listSessions().sessions[0].reviewedChapters, 1);
  } finally {
    h.close();
  }
});

test("getting a session returns it with human state and findings carrying ids", async () => {
  const h = setup();
  try {
    const result = h.api.getSession(h.readyId);
    assert.equal(result.session.id, h.readyId);
    assert.deepEqual(result.human, {
      chapters: {},
      files: {},
      verdicts: {},
      comments: [],
    });
    assert.deepEqual(
      result.findings,
      findings.map((f) => ({ ...f, id: findingId(f) })),
    );
    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    assert.deepEqual(h.api.getSession(queued.id).findings, []);
    assert.throws(() => h.api.getSession("missing"), NotFoundError);
  } finally {
    h.close();
  }
});

test("rerun creates and starts a new session for the same pull request", async () => {
  const h = setup();
  try {
    const { id } = await h.api.rerun(h.readyId);
    assert.notEqual(id, h.readyId);
    assert.deepEqual(h.started, [id]);
    assert.equal(h.store.get(id)?.prNumber, 7);
    assert.deepEqual(h.store.get(id)?.repo, repo);
    await assert.rejects(h.api.rerun("missing"), NotFoundError);
  } finally {
    h.close();
  }
});

test("rerun carries verdicts, marks, and comments to the new session", async () => {
  const h = setup();
  try {
    const kept = findingId(findings[0]);
    h.api.setVerdict(h.readyId, kept, { verdict: "disagree", note: "Fine." });
    h.api.setChapter(h.readyId, "core", { reviewed: true });
    h.api.setFile(h.readyId, { path: "src/a.ts", viewed: true });
    h.api.addComment(h.readyId, { path: "src/a.ts", line: 2, body: "Why?" });
    h.api.addComment(h.readyId, { path: "src/b.ts", line: 1, body: "Ok." });

    const { id } = await h.api.rerun(h.readyId);
    const carried = h.store.human(id);

    assert.equal(carried.verdicts[kept]?.verdict, "disagree");
    assert.equal(carried.verdicts[kept]?.note, "Fine.");
    assert.deepEqual(carried.chapters, { core: true });
    assert.deepEqual(carried.files, { "src/a.ts": true });
    assert.deepEqual(
      carried.comments.map((c) => [c.path, c.line, c.body]),
      [
        ["src/a.ts", 2, "Why?"],
        ["src/b.ts", 1, "Ok."],
      ],
    );
    assert.equal(h.store.human(h.readyId).comments.length, 2);
  } finally {
    h.close();
  }
});

test("rerun is refused while the session is still running", async () => {
  const h = setup();
  try {
    const running = h.store.create({
      repo,
      prNumber: 7,
      agent: "codex",
      account: "alice",
    });
    h.store.update(running.id, { status: "analyzing" });
    await assert.rejects(h.api.rerun(running.id), ConflictError);

    h.store.update(running.id, { status: "failed" });
    assert.notEqual((await h.api.rerun(running.id)).id, running.id);
    assert.equal(h.started.length, 1);
  } finally {
    h.close();
  }
});

test("chapter and file marks round-trip and reject bad bodies and unknown sessions", async () => {
  const h = setup();
  try {
    assert.deepEqual(
      h.api.setChapter(h.readyId, "core", { reviewed: true }).human.chapters,
      { core: true },
    );
    assert.deepEqual(
      h.api.setChapter(h.readyId, "core", { reviewed: false }).human.chapters,
      {},
    );
    assert.deepEqual(
      h.api.setFile(h.readyId, { path: "src/a.ts", viewed: true }).human.files,
      { "src/a.ts": true },
    );
    assert.deepEqual(
      h.api.setFile(h.readyId, { path: "src/a.ts", viewed: false }).human.files,
      {},
    );
    assert.throws(
      () => h.api.setChapter(h.readyId, "core", { reviewed: "yes" }),
      BadRequestError,
    );
    assert.throws(
      () => h.api.setFile(h.readyId, { path: 3, viewed: true }),
      BadRequestError,
    );
    assert.throws(
      () => h.api.setFile(h.readyId, { path: "src/a.ts" }),
      BadRequestError,
    );
    assert.throws(
      () => h.api.setChapter("missing", "core", { reviewed: true }),
      NotFoundError,
    );
    assert.throws(
      () => h.api.setFile("missing", { path: "src/a.ts", viewed: true }),
      NotFoundError,
    );
    assert.deepEqual(h.store.human("missing").chapters, {});
  } finally {
    h.close();
  }
});

test("verdicts are set, cleared, and validated against the session's findings", async () => {
  const h = setup();
  try {
    const id = findingId(findings[0]);
    const set = h.api.setVerdict(h.readyId, id, {
      verdict: "disagree",
      note: "It is checked upstream.",
    });
    assert.equal(set.human.verdicts[id].verdict, "disagree");
    assert.equal(set.human.verdicts[id].note, "It is checked upstream.");
    const noNote = h.api.setVerdict(h.readyId, id, { verdict: "agree" });
    assert.equal(noNote.human.verdicts[id].note, "");
    assert.deepEqual(
      h.api.setVerdict(h.readyId, id, { verdict: null }).human.verdicts,
      {},
    );
    assert.throws(
      () => h.api.setVerdict(h.readyId, "nope", { verdict: "agree" }),
      NotFoundError,
    );
    assert.throws(
      () => h.api.setVerdict("missing", id, { verdict: "agree" }),
      NotFoundError,
    );
    for (const body of [
      { verdict: "maybe" },
      {},
      { verdict: "agree", note: 5 },
    ]) {
      assert.throws(
        () => h.api.setVerdict(h.readyId, id, body),
        BadRequestError,
      );
    }
  } finally {
    h.close();
  }
});

test("comments must target a PR file with a body and a positive line", async () => {
  const h = setup();
  try {
    const added = h.api.addComment(h.readyId, {
      path: "src/a.ts",
      line: 2,
      body: "  Why this?  ",
    });
    assert.equal(added.human.comments.length, 1);
    assert.equal(added.human.comments[0].body, "Why this?");
    for (const body of [
      { path: "src/zzz.ts", line: 2, body: "x" },
      { path: "src/a.ts", line: 2, body: "   " },
      { path: "src/a.ts", line: 0, body: "x" },
      { path: "src/a.ts", line: 1.5, body: "x" },
      { path: "src/a.ts", body: "x" },
      { path: "src/a.ts", line: 2 },
    ]) {
      assert.throws(() => h.api.addComment(h.readyId, body), BadRequestError);
    }
    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    assert.throws(
      () =>
        h.api.addComment(queued.id, { path: "src/a.ts", line: 2, body: "x" }),
      BadRequestError,
    );
    assert.throws(
      () =>
        h.api.addComment("missing", { path: "src/a.ts", line: 2, body: "x" }),
      NotFoundError,
    );

    const commentId = added.human.comments[0].id;
    assert.deepEqual(
      h.api.deleteComment(h.readyId, commentId).human.comments,
      [],
    );
    assert.throws(
      () => h.api.deleteComment(h.readyId, commentId),
      NotFoundError,
    );
    assert.throws(
      () => h.api.deleteComment("missing", commentId),
      NotFoundError,
    );
  } finally {
    h.close();
  }
});

test("publish preview composes the review without posting", async () => {
  const h = setup();
  try {
    const { preview } = h.api.previewPublish(h.readyId, null);
    assert.equal(preview.event, "COMMENT");
    assert.equal(preview.comments.length, 1);
    assert.equal(preview.skipped.length, 1);
    assert.match(preview.body, /## Guided review/);
    assert.equal(
      h.api.previewPublish(h.readyId, "APPROVE").preview.event,
      "APPROVE",
    );
    assert.throws(
      () => h.api.previewPublish(h.readyId, "MERGE"),
      BadRequestError,
    );
    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    assert.throws(() => h.api.previewPublish(queued.id, null), ConflictError);
    assert.throws(() => h.api.previewPublish("missing", null), NotFoundError);
    assert.deepEqual(h.reviews, []);
  } finally {
    h.close();
  }
});

test("publish posts only with confirm: true and records publishedAt once", async () => {
  const h = setup();
  try {
    await assert.rejects(
      h.api.publish(h.readyId, { event: "COMMENT" }),
      BadRequestError,
    );
    await assert.rejects(
      h.api.publish(h.readyId, { event: "COMMENT", confirm: "true" }),
      BadRequestError,
    );
    await assert.rejects(
      h.api.publish(h.readyId, { event: "SHIP", confirm: true }),
      BadRequestError,
    );
    await assert.rejects(h.api.publish(h.readyId, null), BadRequestError);
    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    await assert.rejects(
      h.api.publish(queued.id, { event: "COMMENT", confirm: true }),
      ConflictError,
    );
    await assert.rejects(
      h.api.publish("missing", { event: "COMMENT", confirm: true }),
      NotFoundError,
    );
    assert.deepEqual(h.reviews, []);

    const result = await h.api.publish(h.readyId, {
      event: "REQUEST_CHANGES",
      confirm: true,
    });
    assert.equal(result.ok, true);
    assert.equal(h.store.get(h.readyId)?.publishedAt, result.publishedAt);
    assert.equal(h.reviews.length, 1);
    const posted = h.reviews[0] as Record<string, unknown>;
    assert.deepEqual(posted.repo, repo);
    assert.equal(posted.prNumber, 7);
    assert.equal(posted.event, "REQUEST_CHANGES");
    assert.equal(posted.commitId, "abc123");
    // The session's account posts the review.
    assert.deepEqual(
      h.calls.filter(([m]) => m === "review"),
      [["review", "token:alice"]],
    );
    assert.equal((posted.comments as unknown[]).length, 1);
    assert.match(String(posted.body), /## Guided review/);

    await assert.rejects(
      h.api.publish(h.readyId, { event: "COMMENT", confirm: true }),
      ConflictError,
    );
    assert.equal(h.reviews.length, 1);
  } finally {
    h.close();
  }
});

test("a second publish while the first is in flight is refused, and a failed post can be retried", async () => {
  let release!: () => void;
  let fail = true;
  const posts: string[] = [];
  const h = setup({
    createPullRequestReview: async (args) => {
      posts.push(args.event ?? "");
      if (fail) {
        fail = false;
        throw new Error("GitHub said no");
      }
      await new Promise<void>((done) => {
        release = done;
      });
    },
  });
  try {
    const body = { event: "COMMENT", confirm: true };
    await assert.rejects(h.api.publish(h.readyId, body), /GitHub said no/);
    assert.equal(h.store.get(h.readyId)?.publishedAt, null);

    const first = h.api.publish(h.readyId, body);
    await assert.rejects(h.api.publish(h.readyId, body), ConflictError);
    while (posts.length < 2) await new Promise((done) => setImmediate(done));
    release();
    await first;
    assert.deepEqual(posts, ["COMMENT", "COMMENT"]);
  } finally {
    h.close();
  }
});

test("the discuss prompt carries the PR, guide, findings with ids, and verdicts", async () => {
  const h = setup();
  try {
    const id = findingId(findings[0]);
    h.api.setVerdict(h.readyId, id, { verdict: "unsure", note: "Ask why." });
    const { prompt } = h.api.discuss(h.readyId);
    assert.ok(
      prompt.startsWith(
        "Help me review acme/widgets#7 (https://github.com/acme/widgets/pull/7). Check out branch feat/widgets (base main) in a worktree. Here is the guide:",
      ),
    );
    assert.match(prompt, /Widgets get a new code path\./);
    assert.match(prompt, /1\. Core change: The widget path\./);
    assert.match(prompt, /2\. Other changes: The rest\./);
    assert.ok(
      prompt.includes(
        `- [${id}] src/a.ts:2 (high) Null check missing. — my verdict: unsure (Ask why.)`,
      ),
    );
    assert.ok(
      prompt.includes(
        `- [${findingId(findings[1])}] src/b.ts:9 (low) Off the diff. — my verdict: none`,
      ),
    );
    h.api.setVerdict(h.readyId, findingId(findings[1]), { verdict: "agree" });
    assert.ok(
      h.api
        .discuss(h.readyId)
        .prompt.includes(
          `- [${findingId(findings[1])}] src/b.ts:9 (low) Off the diff. — my verdict: agree\n`,
        ),
    );
    assert.ok(
      prompt.endsWith(
        "Answer my questions about this change; do not post to GitHub.",
      ),
    );

    const bare = h.store.create({
      repo,
      prNumber: 8,
      agent: "codex",
      account: "alice",
    });
    h.store.update(bare.id, { pr });
    const barePrompt = h.api.discuss(bare.id).prompt;
    assert.match(barePrompt, /\(no guide\)/);
    assert.match(barePrompt, /Agent findings:\n\(none\)/);

    const queued = await h.api.createSession({ target: "acme/widgets#3" });
    assert.throws(() => h.api.discuss(queued.id), ConflictError);
    assert.throws(() => h.api.discuss("missing"), NotFoundError);
  } finally {
    h.close();
  }
});

test("open pulls of a repository come as inbox rows of the current account with their latest session", async () => {
  const h = setup({
    client: {
      async listRepoPullRequests(ref, first) {
        h.calls.push(["repoPulls", ref, first]);
        return [card({ number: 7 }), card({ number: 4, state: "draft" })];
      },
    },
  });
  try {
    const { pulls } = await h.api.listPulls("acme", "widgets");
    assert.deepEqual(
      pulls.map((p) => [p.number, p.state, p.groups, p.sessionId]),
      [
        [7, "open", [], h.readyId],
        [4, "draft", [], null],
      ],
    );
    assert.deepEqual(h.calls, [["repoPulls", repo, 50]]);
    await assert.rejects(h.api.listPulls("acme", "bad repo"), BadRequestError);
    await assert.rejects(h.api.listPulls("../x", "widgets"), BadRequestError);
    assert.equal(h.calls.length, 1);
  } finally {
    h.close();
  }
});

test("a pull's preview carries the body and validates the number", async () => {
  const h = setup();
  try {
    const { pull } = await h.api.getPull("acme", "widgets", "7");
    assert.equal(pull.body, "Adds widgets.");
    assert.equal(pull.sessionId, h.readyId);
    assert.deepEqual(pull.groups, []);
    assert.deepEqual(h.calls, [["detail", "token:alice", repo, 7]]);
    for (const n of ["0", "-1", "1.5", "x", "99999999999999999999"])
      await assert.rejects(
        h.api.getPull("acme", "widgets", n),
        BadRequestError,
      );
  } finally {
    h.close();
  }
});

test("accounts list gh's logins, and the current one persists and is validated", async () => {
  const h = setup();
  try {
    assert.deepEqual(await h.api.accounts(), {
      accounts: [
        { login: "alice", avatarUrl: "https://avatars.test/alice", ok: true },
        { login: "bob", avatarUrl: "https://avatars.test/bob", ok: true },
      ],
      current: "alice",
    });
    assert.deepEqual(await h.api.setCurrentAccount({ login: "bob" }), {
      current: "bob",
    });
    assert.equal((await h.api.accounts()).current, "bob");
    for (const body of [{ login: "mallory" }, { login: "" }, {}, null])
      await assert.rejects(h.api.setCurrentAccount(body), BadRequestError);
    assert.equal((await h.api.accounts()).current, "bob");

    // New sessions, the inbox, and repo pulls now act as bob.
    const { id } = await h.api.createSession({ target: "acme/widgets#3" });
    assert.equal(h.store.get(id)?.account, "bob");
    const inbox = await h.api.inbox(false);
    assert.equal(inbox.account, "bob");
    assert.equal(inbox.viewer, "bob");
    await h.api.listPulls("acme", "widgets");
    assert.ok(h.calls.every((c) => c[1] === "token:bob"));
  } finally {
    h.close();
  }
});

test("the inbox merges the three searches by PR with groups and the latest session", async () => {
  const shared = card({ number: 7, updatedAt: "2026-10-07T02:00:00Z" });
  const mine = card({ number: 9, updatedAt: "2026-10-07T03:00:00Z" });
  let searches = 0;
  const h = setup({
    client: {
      async searchPullRequests(query) {
        searches += 1;
        if (query.includes("involves:@me"))
          return { pulls: [], truncated: true, warnings: ["SSO required"] };
        // A search can list a PR twice; the row keeps one group entry.
        return {
          pulls: query.includes("review-requested")
            ? [shared]
            : [mine, shared, mine],
          truncated: false,
          warnings: [],
        };
      },
    },
  });
  try {
    const inbox = await h.api.inbox(false);
    assert.equal(inbox.account, "alice");
    assert.equal(inbox.viewer, "alice");
    assert.ok(!Number.isNaN(Date.parse(inbox.fetchedAt)));
    assert.deepEqual(inbox.truncated, {
      reviewRequested: false,
      authored: false,
      involved: true,
    });
    assert.deepEqual(inbox.warnings, ["SSO required"]);
    assert.equal(inbox.stale, false);
    assert.deepEqual(
      inbox.pulls.map((p) => [p.number, p.groups, p.sessionId]),
      [
        [9, ["authored"], null],
        [7, ["reviewRequested", "authored"], h.readyId],
      ],
    );
    assert.equal(searches, 3);

    // Cached for the account; a new session shows without a refetch.
    const { id } = await h.api.createSession({ target: "acme/widgets#9" });
    const again = await h.api.inbox(false);
    assert.equal(searches, 3);
    assert.equal(again.pulls[0].sessionId, id);
    await h.api.inbox(true);
    assert.equal(searches, 6);
  } finally {
    h.close();
  }
});

test("checks for a session use its account, and per-PR checks the current one", async () => {
  const h = setup({
    client: {
      async getPullRequestChecks(ref, n) {
        h.calls.push(["checks", ref, n]);
        return {
          headSha: "abc123",
          checks: [
            {
              name: "test",
              workflowName: "CI",
              status: "failure",
              url: null,
              startedAt: "2026-10-07T00:00:00Z",
              completedAt: "2026-10-07T00:01:00Z",
            },
          ],
          truncated: false,
          overall: null,
        };
      },
    },
  });
  try {
    const bobs = h.store.create({
      repo,
      prNumber: 8,
      agent: "codex",
      account: "bob",
    });
    const checks = await h.api.sessionChecks(bobs.id);
    assert.equal(checks.rollup, "failing");
    assert.equal(checks.headSha, "abc123");
    assert.equal(checks.checks.length, 1);
    await h.api.pullChecks("acme", "widgets", "5");
    assert.deepEqual(h.calls, [
      ["checks", repo, 8],
      ["checks", repo, 5],
    ]);
    await assert.rejects(h.api.sessionChecks("missing"), NotFoundError);
    await assert.rejects(
      h.api.pullChecks("acme", "widgets", "x"),
      BadRequestError,
    );
    await assert.rejects(
      h.api.pullChecks("a b", "widgets", "1"),
      BadRequestError,
    );
  } finally {
    h.close();
  }
});

test("a session stored without an account does not act as the current account", async () => {
  const h = setup();
  try {
    const legacy = h.store.create({
      repo,
      prNumber: 8,
      agent: "codex",
      account: "",
    });
    h.store.update(legacy.id, { status: "failed" });
    await h.api.setCurrentAccount({ login: "bob" });
    await assert.rejects(
      h.api.rerun(legacy.id),
      (err: Error) =>
        err instanceof ConflictError &&
        /choose the account for this review/.test(err.message),
    );
    await assert.rejects(
      h.api.rerun(legacy.id, { account: 5 }),
      BadRequestError,
    );
    await assert.rejects(
      h.api.rerun(legacy.id, { account: "mallory" }),
      BadRequestError,
    );
    const { id } = await h.api.rerun(legacy.id, { account: "alice" });
    assert.equal(h.store.get(id)?.account, "alice");

    // Publishing waits until the account is chosen, once.
    h.store.update(h.readyId, { account: "" });
    const body = { event: "COMMENT", confirm: true };
    await assert.rejects(h.api.publish(h.readyId, body), ConflictError);
    assert.ok(h.calls.every((c) => c[0] !== "review"));
    for (const bad of [{ login: "" }, { login: "mallory" }, {}])
      await assert.rejects(
        h.api.setSessionAccount(h.readyId, bad),
        BadRequestError,
      );
    assert.deepEqual(
      await h.api.setSessionAccount(h.readyId, { login: "bob" }),
      {
        account: "bob",
      },
    );
    assert.deepEqual(
      await h.api.setSessionAccount(h.readyId, { login: "bob" }),
      {
        account: "bob",
      },
    );
    await assert.rejects(
      h.api.setSessionAccount(h.readyId, { login: "alice" }),
      /already belongs to bob/,
    );
    await h.api.publish(h.readyId, body);
    assert.ok(h.calls.some((c) => c[0] === "review" && c[1] === "token:bob"));

    // A login that gh no longer has is refused, not silently replaced.
    const gone = h.store.create({
      repo,
      prNumber: 9,
      agent: "codex",
      account: "carol",
    });
    h.store.update(gone.id, { status: "failed" });
    await assert.rejects(h.api.rerun(gone.id), BadRequestError);
    await assert.rejects(
      h.api.rerun(gone.id, { account: "alice" }),
      BadRequestError,
    );
  } finally {
    h.close();
  }
});

test("settled waits for a publish in flight", async () => {
  let release!: () => void;
  const h = setup({
    createPullRequestReview: () =>
      new Promise<void>((done) => {
        release = done;
      }),
  });
  try {
    await h.api.settled();
    const publish = h.api.publish(h.readyId, {
      event: "COMMENT",
      confirm: true,
    });
    let settled = false;
    const waiting = h.api.settled().then(() => {
      settled = true;
    });
    while (release === undefined) await new Promise((d) => setImmediate(d));
    await new Promise((d) => setImmediate(d));
    assert.equal(settled, false);
    release();
    await waiting;
    assert.notEqual(h.store.get(h.readyId)?.publishedAt, null);
    await publish;
  } finally {
    h.close();
  }
});

test("a failure other than an unknown account passes through", async () => {
  const accounts = fakeAccounts();
  accounts.list = async () => {
    throw new Error("gh exploded");
  };
  const h = setup({ accounts });
  try {
    await assert.rejects(
      h.api.createSession({ target: "acme/widgets#3", account: "bob" }),
      /gh exploded/,
    );
  } finally {
    h.close();
  }
});
