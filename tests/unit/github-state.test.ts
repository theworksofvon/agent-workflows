import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubRepoStateStore } from "../../src/adapters/state/json-file.js";
import type { CommentBatch } from "../../src/domain/events.js";

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
        repo: { owner: "local-owner", repo: "sample-repo" },
        number: 1,
        title: "Test PR",
        body: null,
        headRef: "feature/test",
        baseRef: "main",
        draft: false,
        fromFork: false,
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
    assert.equal(
      state.hasProcessedComment("local-owner/sample-repo#1:review:100"),
      false,
    );

    state.markBatchCompleted(batch);
    assert.equal(
      state.hasProcessedComment("local-owner/sample-repo#1:review:100"),
      true,
    );
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
        repo: { owner: "local-owner", repo: "sample-repo" },
        number: 1,
        title: "Test PR",
        body: null,
        headRef: "feature/test",
        baseRef: "main",
        draft: false,
        fromFork: false,
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

    const [firstAttempt] = state.takeReadyCommentBatches(
      2_000,
      immediatePolicy,
    );
    assert.equal(firstAttempt.attempts, 1);
    state.pauseBatchForRetry({
      batch: firstAttempt as CommentBatch,
      retryAfterMs: 5_000,
      error: "usage limit reached",
    });
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      now: 3_000,
      pr: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        number: 1,
        title: "Updated title",
        body: "body",
        headRef: "feature/test",
        baseRef: "main",
        draft: false,
        fromFork: false,
      },
      comment: {
        key: "local-owner/sample-repo#1:review:101",
        id: 101,
        kind: "review",
        author: "reviewer",
        body: "second fix",
        createdAt: new Date(3_000).toISOString(),
      },
    });

    assert.deepEqual(state.takeReadyCommentBatches(4_000, immediatePolicy), []);
    const [secondAttempt] = state.takeReadyCommentBatches(
      5_000,
      immediatePolicy,
    );
    assert.equal(secondAttempt.attempts, 2);
    assert.equal(secondAttempt.comments.length, 2);
    assert.equal(
      secondAttempt.comments[0].key,
      "local-owner/sample-repo#1:review:100",
    );
    assert.equal(
      state.hasProcessedComment("local-owner/sample-repo#1:review:100"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const samplePr = {
  repo: { owner: "local-owner", repo: "sample-repo" },
  number: 1,
  title: "Test PR",
  body: null,
  headRef: "feature/test",
  baseRef: "main",
  draft: false,
  fromFork: false,
};
const sampleComment = (id: number, at: number) => ({
  key: `local-owner/sample-repo#1:review:${id}`,
  id,
  kind: "review" as const,
  author: "reviewer",
  body: `fix ${id}`,
  createdAt: new Date(at).toISOString(),
});

test("a batch taken by a run that never finished is queued again on reload", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-inflight-"));
  try {
    const state = makeState(root);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      pr: samplePr,
      now: 1_000,
      comment: sampleComment(100, 1_000),
    });
    const [taken] = state.takeReadyCommentBatches(2_000, immediatePolicy);
    assert.equal(taken.attempts, 1);
    // A comment arriving mid-run opens a fresh pending group under the key.
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      pr: samplePr,
      now: 3_000,
      comment: sampleComment(101, 3_000),
    });
    // The process dies here without completing or pausing the batch.

    const reloaded = makeState(root);
    const [restored] = reloaded.takeReadyCommentBatches(4_000, immediatePolicy);
    assert.equal(restored.batchId, taken.batchId);
    assert.equal(restored.attempts, 2);
    assert.deepEqual(
      restored.comments.map((c) => c.id),
      [100, 101],
    );
    assert.equal(
      reloaded.takeReadyCommentBatches(5_000, immediatePolicy).length,
      0,
    );

    reloaded.markBatchCompleted(restored);
    const third = makeState(root);
    assert.deepEqual(third.takeReadyCommentBatches(6_000, immediatePolicy), []);
    assert.equal(
      third.hasProcessedComment("local-owner/sample-repo#1:review:101"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restored batch without newer comments is queued as it was taken", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-inflight-"));
  try {
    const state = makeState(root);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      pr: samplePr,
      now: 1_000,
      comment: sampleComment(100, 1_000),
    });
    state.takeReadyCommentBatches(2_000, immediatePolicy);
    const [restored] = makeState(root).takeReadyCommentBatches(
      3_000,
      immediatePolicy,
    );
    assert.deepEqual(
      restored.comments.map((c) => c.id),
      [100],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pausing a batch merges comments that arrived while it ran", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-merge-"));
  try {
    const state = makeState(root);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      pr: samplePr,
      now: 1_000,
      comment: sampleComment(100, 1_000),
    });
    const [taken] = state.takeReadyCommentBatches(2_000, immediatePolicy);
    state.addPendingComment({
      groupKey: "pr:1:review:10",
      pr: samplePr,
      now: 3_000,
      comment: sampleComment(101, 3_000),
    });
    state.pauseBatchForRetry({
      batch: taken,
      retryAfterMs: 4_000,
      error: "rate limited",
    });
    const [retried] = state.takeReadyCommentBatches(4_000, immediatePolicy);
    assert.deepEqual(
      retried.comments.map((c) => c.id),
      [100, 101],
    );
    assert.equal(retried.lastSeenAt, new Date(3_000).toISOString());
    assert.equal(retried.attempts, 2);
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
      repo: { owner: "local-owner", repo: "sample-repo" },
      number: 1,
      title: "Test PR",
      body: null,
      headRef: "feature/test",
      baseRef: "main",
      draft: false,
      fromFork: false,
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

test("state persists initialization, ordered pending comments, duplicate guards, and retained history", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-complete-"));
  try {
    const state = new GitHubRepoStateStore(
      join(root, "state"),
      { owner: "local-owner", repo: "sample-repo" },
      { processedCommentKeyLimit: 2, commentBatchHistoryLimit: 2 },
    );
    assert.equal(state.isPollingInitialized(), false);
    state.markPollingInitialized();
    state.markPollingInitialized();
    assert.equal(state.isPollingInitialized(), true);
    const pr = {
      repo: { owner: "local-owner", repo: "sample-repo" },
      number: 1,
      title: "PR",
      body: "body",
      headRef: "head",
      baseRef: "base",
      draft: false,
      fromFork: false,
    };
    const add = (key: string, id: number, createdAt: number, now: number) =>
      state.addPendingComment({
        groupKey: "group",
        pr,
        now,
        comment: {
          key,
          id,
          kind: "issue",
          author: "author",
          body: key,
          createdAt: new Date(createdAt).toISOString(),
        },
      });
    add("later", 3, 3_000, 3_000);
    add("same-high", 2, 1_000, 4_000);
    add("same-low", 1, 1_000, 5_000);
    add("same-low", 1, 1_000, 6_000);
    assert.deepEqual(
      state.takeReadyCommentBatches(5_001, {
        quietWindowMs: 10,
        minComments: 1,
        maxWaitMs: 0,
      }),
      [],
    );
    const [batch] = state.takeReadyCommentBatches(5_010, immediatePolicy);
    assert.deepEqual(
      batch.comments.map((comment) => comment.id),
      [1, 2, 3],
    );

    state.recordPrHistory(1, {
      batchId: "one",
      handledAt: "1",
      agent: "a",
      exitCode: 0,
      commitCount: 0,
      commentKeys: ["one"],
      summary: "one",
    });
    state.recordPrHistory(1, {
      batchId: "two",
      handledAt: "2",
      agent: "a",
      exitCode: 0,
      commitCount: 0,
      commentKeys: ["two"],
      summary: "two",
    });
    state.recordPrHistory(1, {
      batchId: "three",
      handledAt: "3",
      agent: "a",
      exitCode: 0,
      commitCount: 0,
      commentKeys: ["three"],
      summary: "three",
    });
    assert.deepEqual(
      state.getRecentPrHistory(1, 1).map((entry) => entry.batchId),
      ["three"],
    );
    assert.deepEqual(state.getRecentPrHistory(99, 5), []);

    const entry = {
      reviewedAt: "now",
      agent: "a",
      findingCount: 2,
      postedFindingCount: 1,
      dryRun: false,
      summary: "review",
    };
    state.recordReviewRun({ prNumber: 1, entry, postedFindingKeys: [] });
    state.recordReviewRun({
      prNumber: 1,
      entry,
      postedFindingKeys: ["one", "two"],
    });
    state.recordReviewRun({
      prNumber: 1,
      entry,
      postedFindingKeys: ["two", "three"],
    });
    assert.deepEqual(state.getPostedReviewFindingKeys(1), ["two", "three"]);
    assert.deepEqual(state.getPostedReviewFindingKeys(99), []);

    state.markBatchCompleted(batch);
    assert.equal(state.hasProcessedComment("later"), true);
    assert.equal(state.hasProcessedComment("same-high"), true);
    assert.equal(state.hasProcessedComment("same-low"), false);
    const reloaded = makeState(root);
    assert.equal(reloaded.isPollingInitialized(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state normalizes legacy files, infers cursors, applies zero limits, and resets corrupt files", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-legacy-"));
  try {
    const dir = join(root, "state", "github", "local-owner");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sample-repo.json");
    writeFileSync(
      file,
      JSON.stringify({
        cursors: { issueCommentId: 7 },
        prs: {
          "1": {
            cursors: { issueCommentId: 99 },
            commentBatchHistory: [
              {
                batchId: "legacy",
                handledAt: "now",
                agent: "a",
                exitCode: 0,
                commitCount: 0,
                commentKeys: [
                  "repo#1:issue:12",
                  "repo#1:review:20",
                  "bad-key",
                  "repo#1:issue:3",
                ],
                summary: "legacy",
              },
            ],
          },
        },
      }),
    );
    const state = new GitHubRepoStateStore(
      join(root, "state"),
      { owner: "local-owner", repo: "sample-repo" },
      {
        processedCommentKeyLimit: 0,
        commentBatchHistoryLimit: 0,
      },
    );
    assert.equal(state.isPollingInitialized(), true);
    assert.equal(state.getIssueCommentCursor(1), 99);
    assert.equal(state.getReviewCommentCursor(1), 20);
    assert.deepEqual(state.getRecentPrHistory(1, 0), []);
    state.recordPrHistory(2, {
      batchId: "gone",
      handledAt: "",
      agent: "",
      exitCode: 0,
      commitCount: 0,
      commentKeys: [],
      summary: "",
    });
    assert.deepEqual(state.getRecentPrHistory(2, 2), []);
    state.recordReviewRun({
      prNumber: 2,
      entry: {
        reviewedAt: "",
        agent: "",
        findingCount: 0,
        postedFindingCount: 0,
        dryRun: false,
        summary: "",
      },
      postedFindingKeys: ["gone"],
    });
    assert.deepEqual(state.getPostedReviewFindingKeys(2), []);

    writeFileSync(
      file,
      JSON.stringify({
        pollingInitialized: false,
        cursors: { issueCommentId: 1, reviewCommentId: 2 },
        pendingCommentGroups: {},
        processedCommentKeys: ["saved"],
        prs: {
          "3": {
            cursors: { reviewCommentId: 33 },
            commentBatchHistory: [],
            reviewRunHistory: [
              {
                reviewedAt: "",
                agent: "",
                findingCount: 0,
                postedFindingCount: 0,
                dryRun: true,
                summary: "",
              },
            ],
            postedReviewFindingKeys: ["finding"],
          },
          "4": {},
        },
      }),
    );
    const explicit = makeState(root);
    assert.equal(explicit.isPollingInitialized(), false);
    assert.equal(explicit.getIssueCommentCursor(3), 0);
    assert.equal(explicit.getReviewCommentCursor(3), 33);
    assert.equal(explicit.hasProcessedComment("saved"), true);
    assert.deepEqual(explicit.getPostedReviewFindingKeys(3), ["finding"]);
    assert.equal(explicit.getIssueCommentCursor(4), 0);

    writeFileSync(file, "{}");
    const emptyLegacy = makeState(root);
    assert.equal(emptyLegacy.isPollingInitialized(), true);
    assert.equal(emptyLegacy.getIssueCommentCursor(1), 0);

    writeFileSync(file, "{");
    const reset = makeState(root);
    assert.equal(reset.isPollingInitialized(), false);
    assert.equal(reset.getIssueCommentCursor(1), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
