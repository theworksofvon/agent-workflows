import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openStateDatabase,
  SqliteRepoStateStore,
} from "../../src/adapters/state/sqlite.js";
import type { Comment, PullRequest } from "../../src/domain/events.js";
import { ingestComment } from "../../src/services/intake.js";

const pr: PullRequest = {
  repo: { owner: "o", repo: "r" },
  number: 4,
  title: "t",
  body: null,
  headRef: "f",
  baseRef: "main",
  draft: false,
  fromFork: false,
};
const comment = (over: Partial<Comment> = {}): Comment => ({
  key: "o/r#4:issue:10",
  id: 10,
  kind: "issue",
  author: "alice",
  body: "fix",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});
const openDatabases: DatabaseSync[] = [];
const makeState = (root: string) => {
  const db = openStateDatabase(root);
  openDatabases.push(db);
  return new SqliteRepoStateStore(db, pr.repo, {
    processedCommentKeyLimit: 10,
    commentBatchHistoryLimit: 5,
  });
};
const cleanup = (root: string) => {
  for (const db of openDatabases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
};
const policy = { allowedAuthors: null, agentSelfUser: null };

test("accepted comment joins a pending group and leaves cursors to the poller", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = makeState(root);
    const result = ingestComment({
      state,
      pr,
      comment: comment(),
      now: 1_000,
      policy,
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(state.getIssueCommentCursor(4), 0);
    const batches = state.takeReadyCommentBatches(1_000, {
      quietWindowMs: 0,
      minComments: 1,
      maxWaitMs: 0,
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].comments[0].key, "o/r#4:issue:10");
  } finally {
    cleanup(root);
  }
});

test("review comments and summaries are ingested without moving any cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = makeState(root);
    ingestComment({
      state,
      pr,
      now: 1,
      policy,
      comment: comment({
        key: "o/r#4:review:22",
        id: 22,
        kind: "review",
        reviewId: 3,
        review: { path: "a.ts", line: 1, diffHunk: "@@" },
      }),
    });
    ingestComment({
      state,
      pr,
      now: 1,
      policy,
      comment: comment({
        key: "o/r#4:review_summary:99",
        id: 99,
        kind: "review_summary",
      }),
    });
    assert.equal(state.getReviewCommentCursor(4), 0);
    assert.equal(state.getIssueCommentCursor(4), 0);
    const [batch] = state.takeReadyCommentBatches(1, {
      quietWindowMs: 0,
      minComments: 1,
      maxWaitMs: 0,
    });
    assert.equal(batch.comments[0].key, "o/r#4:review:22");
  } finally {
    cleanup(root);
  }
});

test("dropped and processed comments are reported with a reason", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = makeState(root);
    assert.deepEqual(
      ingestComment({
        state,
        pr,
        now: 1,
        policy: { ...policy, allowedAuthors: ["bob"] },
        comment: comment(),
      }),
      { accepted: false, reason: "author-not-allowed" },
    );
    ingestComment({ state, pr, now: 1, policy, comment: comment() });
    const [batch] = state.takeReadyCommentBatches(1, {
      quietWindowMs: 0,
      minComments: 1,
      maxWaitMs: 0,
    });
    state.markBatchCompleted(batch);
    assert.deepEqual(
      ingestComment({ state, pr, now: 2, policy, comment: comment() }),
      { accepted: false, reason: "processed" },
    );
  } finally {
    cleanup(root);
  }
});

test("bot-authored review comments are dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = makeState(root);
    const result = ingestComment({
      state,
      pr,
      now: 1,
      policy,
      comment: comment({
        key: "o/r#4:review:31",
        id: 31,
        kind: "review",
        author: "x[bot]",
        reviewId: 8,
        review: { path: "a.ts", line: 1, diffHunk: "@@" },
      }),
    });
    assert.deepEqual(result, { accepted: false, reason: "bot" });
    assert.deepEqual(
      state.takeReadyCommentBatches(1, {
        quietWindowMs: 0,
        minComments: 1,
        maxWaitMs: 0,
      }),
      [],
    );
  } finally {
    cleanup(root);
  }
});

test("a comment already running in a batch is not queued a second time", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = makeState(root);
    const policyNow = { quietWindowMs: 0, minComments: 1, maxWaitMs: 0 };
    ingestComment({ state, pr, now: 1, policy, comment: comment() });
    const [running] = state.takeReadyCommentBatches(1, policyNow);
    assert.equal(running.comments.length, 1);

    // The poller re-reads the same comment while the webhook-started run is live.
    assert.deepEqual(
      ingestComment({ state, pr, now: 2, policy, comment: comment() }),
      { accepted: true },
    );
    assert.deepEqual(state.takeReadyCommentBatches(2, policyNow), []);
  } finally {
    cleanup(root);
  }
});
