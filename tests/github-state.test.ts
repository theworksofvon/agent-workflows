import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubRepoStateStore } from "../src/github/state.js";
import type { PRCommentPayload } from "../src/github/poller.js";

function makeState(root: string): GitHubRepoStateStore {
  return new GitHubRepoStateStore(
    join(root, "state"),
    { owner: "local-owner", repo: "sample-repo" },
    { processedCommentKeyLimit: 20, commentBatchHistoryLimit: 20 },
  );
}

const immediatePolicy = {
  quietWindowMs: 0,
  minComments: 1,
  maxWaitMs: 0,
};

test("ready batches are not marked processed until completed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-"));
  try {
    const state = makeState(root);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      now: 1_000,
      pr: {
        number: 1,
        title: "Test PR",
        body: null,
        headRef: "feature/test",
        baseRef: "main",
      },
      comment: {
        key: "local-owner/sample-repo#1:review:100",
        id: 100,
        kind: "review",
        author: "reviewer",
        body: "please fix",
        createdAt: new Date(1_000).toISOString(),
      },
    });

    const [batch] = state.takeReadyCommentBatches(2_000, immediatePolicy);
    assert.equal(batch.comments.length, 1);
    assert.equal(state.hasProcessedComment("local-owner/sample-repo#1:review:100"), false);

    state.markBatchCompleted(batch);
    assert.equal(state.hasProcessedComment("local-owner/sample-repo#1:review:100"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retryable failures pause and later re-emit the batch", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-retry-"));
  try {
    const state = makeState(root);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      now: 1_000,
      pr: {
        number: 1,
        title: "Test PR",
        body: null,
        headRef: "feature/test",
        baseRef: "main",
      },
      comment: {
        key: "local-owner/sample-repo#1:review:100",
        id: 100,
        kind: "review",
        author: "reviewer",
        body: "please fix",
        createdAt: new Date(1_000).toISOString(),
      },
    });

    const [firstAttempt] = state.takeReadyCommentBatches(2_000, immediatePolicy);
    assert.equal(firstAttempt.attempts, 1);
    state.pauseBatchForRetry({
      batch: firstAttempt as PRCommentPayload,
      retryAfterMs: 5_000,
      error: "usage limit reached",
    });

    assert.deepEqual(state.takeReadyCommentBatches(4_000, immediatePolicy), []);
    const [secondAttempt] = state.takeReadyCommentBatches(5_000, immediatePolicy);
    assert.equal(secondAttempt.attempts, 2);
    assert.equal(secondAttempt.comments[0].key, "local-owner/sample-repo#1:review:100");
    assert.equal(state.hasProcessedComment("local-owner/sample-repo#1:review:100"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment batches wait for a count threshold or maximum age", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-threshold-"));
  try {
    const state = makeState(root);
    const policy = { quietWindowMs: 0, minComments: 2, maxWaitMs: 5_000 };
    const pr = {
      number: 1,
      title: "Test PR",
      body: null,
      headRef: "feature/test",
      baseRef: "main",
    };

    state.addPendingComment({
      groupKey: "pr:1:conversation",
      now: 1_000,
      pr,
      comment: {
        key: "local-owner/sample-repo#1:issue:100",
        id: 100,
        kind: "issue",
        author: "reviewer",
        body: "first comment",
        createdAt: new Date(1_000).toISOString(),
      },
    });
    assert.deepEqual(state.takeReadyCommentBatches(2_000, policy), []);

    state.addPendingComment({
      groupKey: "pr:1:conversation",
      now: 2_000,
      pr,
      comment: {
        key: "local-owner/sample-repo#1:issue:101",
        id: 101,
        kind: "issue",
        author: "reviewer",
        body: "second comment",
        createdAt: new Date(2_000).toISOString(),
      },
    });
    const [thresholdBatch] = state.takeReadyCommentBatches(2_000, policy);
    assert.equal(thresholdBatch.comments.length, 2);

    state.addPendingComment({
      groupKey: "pr:2:conversation",
      now: 10_000,
      pr: { ...pr, number: 2 },
      comment: {
        key: "local-owner/sample-repo#2:issue:200",
        id: 200,
        kind: "issue",
        author: "reviewer",
        body: "only comment",
        createdAt: new Date(10_000).toISOString(),
      },
    });
    assert.deepEqual(state.takeReadyCommentBatches(14_999, policy), []);
    const [agedBatch] = state.takeReadyCommentBatches(15_000, policy);
    assert.equal(agedBatch.comments.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment cursors are tracked per pull request", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-cursors-"));
  try {
    const state = makeState(root);

    state.setIssueCommentCursor(1, 100);
    state.setReviewCommentCursor(1, 200);
    state.setIssueCommentCursor(2, 10);
    state.setReviewCommentCursor(2, 20);

    assert.equal(state.getIssueCommentCursor(1), 100);
    assert.equal(state.getReviewCommentCursor(1), 200);
    assert.equal(state.getIssueCommentCursor(2), 10);
    assert.equal(state.getReviewCommentCursor(2), 20);
    assert.equal(state.getIssueCommentCursor(3), 0);
    assert.equal(state.getReviewCommentCursor(3), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
