import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRepoStateStore } from "../../src/adapters/state/json-file.js";
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
const policy = { allowedAuthors: null, agentSelfUser: null };

test("accepted comment joins a pending group and advances the cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = new GitHubRepoStateStore(root, pr.repo, {
      processedCommentKeyLimit: 10,
      commentBatchHistoryLimit: 5,
    });
    const result = ingestComment({
      state,
      pr,
      comment: comment(),
      now: 1_000,
      policy,
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(state.getIssueCommentCursor(4), 10);
    const batches = state.takeReadyCommentBatches(1_000, {
      quietWindowMs: 0,
      minComments: 1,
      maxWaitMs: 0,
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].comments[0].key, "o/r#4:issue:10");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review comments advance the review cursor; summaries touch none", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = new GitHubRepoStateStore(root, pr.repo, {
      processedCommentKeyLimit: 10,
      commentBatchHistoryLimit: 5,
    });
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
    assert.equal(state.getReviewCommentCursor(4), 22);
    assert.equal(state.getIssueCommentCursor(4), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dropped and processed comments are reported with a reason", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = new GitHubRepoStateStore(root, pr.repo, {
      processedCommentKeyLimit: 10,
      commentBatchHistoryLimit: 5,
    });
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
    assert.equal(state.getIssueCommentCursor(4), 10);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("bot-authored review comments are dropped and still advance the review cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = new GitHubRepoStateStore(root, pr.repo, {
      processedCommentKeyLimit: 10,
      commentBatchHistoryLimit: 5,
    });
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
    assert.equal(state.getReviewCommentCursor(4), 31);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older comment id never moves the cursor backwards", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-intake-"));
  try {
    const state = new GitHubRepoStateStore(root, pr.repo, {
      processedCommentKeyLimit: 10,
      commentBatchHistoryLimit: 5,
    });
    ingestComment({ state, pr, now: 1, policy, comment: comment() });
    ingestComment({
      state,
      pr,
      now: 1,
      policy,
      comment: comment({ key: "o/r#4:issue:5", id: 5 }),
    });
    assert.equal(state.getIssueCommentCursor(4), 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
