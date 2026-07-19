import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type {
  PRCommentBatchHistory,
  PRCommentPayload,
} from "../src/github/poller.js";
import type { RunCtx } from "../src/workflows/types.js";
import type { WorkdirHandle } from "../src/runner/workdir.js";
import { buildPrompt } from "../src/workflows/pr-comment/context.js";
import {
  defaultPRCommentWorkflowDependencies,
  prCommentWorkflow,
  type PRCommentWorkflowDependencies,
} from "../src/workflows/pr-comment/index.js";

function config(root: string): Config {
  return {
    githubToken: "token",
    repos: [],
    pollIntervalSec: 5,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 2,
    agentMaxAttempts: 3,
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    stateDir: join(root, "state"),
    zcodeBin: "z",
    claudeCodeBin: "c",
    codexBin: "x",
    keepWorkdirs: false,
  };
}

function payload(overrides: Partial<PRCommentPayload> = {}): PRCommentPayload {
  return {
    repo: { owner: "owner", repo: "repo" },
    prNumber: 4,
    prTitle: "PR title",
    prBody: null,
    headRef: "feature",
    baseRef: "main",
    batchId: "batch-1",
    groupKey: "group-1",
    firstSeenAt: new Date(1_000).toISOString(),
    lastSeenAt: new Date(2_000).toISOString(),
    attempts: 1,
    comments: [
      {
        key: "owner/repo#4:issue:1",
        id: 1,
        kind: "issue",
        author: "alice",
        body: "fix",
        createdAt: new Date(1_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

function handle(root: string): WorkdirHandle {
  return {
    path: root,
    branch: "feature",
    localBranch: "local",
    baseSha: "abc",
    repoCachePath: root,
  };
}

function context(root: string, comments: string[]): RunCtx {
  return {
    config: config(root),
    agent: {
      name: "fake",
      async run() {
        throw new Error("injected runner should be used");
      },
    },
    async postMarkerComment(args) {
      comments.push(args.body);
    },
  };
}

function dependencies(
  root: string,
  overrides: Partial<PRCommentWorkflowDependencies> = {},
): { deps: PRCommentWorkflowDependencies; calls: string[] } {
  const calls: string[] = [];
  const deps: PRCommentWorkflowDependencies = {
    ...defaultPRCommentWorkflowDependencies,
    prepareWorkdir: (args) => {
      calls.push(`prepare:${args.taskId}`);
      return handle(root);
    },
    cleanupWorkdir: (_handle, keep) => {
      calls.push(`cleanup:${keep}`);
    },
    runAgent: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    buildPrompt: (batch, history = []) => {
      calls.push(`prompt:${history.length}`);
      return buildPrompt(batch, history);
    },
    commitUncommittedChanges: () => false,
    commitsAhead: () => 0,
    pushBranch: () => {
      calls.push("push");
    },
    now: () => 10_000,
    ...overrides,
  };
  return { deps, calls };
}

test("PR comment prompt includes descriptions, bounded history, inline locations, and plural grammar", () => {
  const batch = payload({
    prBody: "Description",
    comments: [
      {
        key: "one",
        id: 1,
        kind: "review",
        author: "alice",
        body: "first",
        createdAt: "now",
        review: { path: "a.ts", line: 7, diffHunk: "@@" },
      },
      {
        key: "two",
        id: 2,
        kind: "review",
        author: "bob",
        body: "second",
        createdAt: "later",
        review: { path: "b.ts", line: null, diffHunk: "@@" },
      },
      {
        key: "three",
        id: 3,
        kind: "issue",
        author: "carol",
        body: "third",
        createdAt: "later",
      },
    ],
  });
  const history: PRCommentBatchHistory[] = Array.from(
    { length: 6 },
    (_, index) => ({
      batchId: String(index),
      handledAt: `time-${index}`,
      agent: "agent",
      exitCode: index,
      commitCount: index === 1 ? 1 : 2,
      commentKeys: index === 1 ? ["one"] : ["one", "two"],
      summary: `summary-${index}`,
    }),
  );
  const prompt = buildPrompt(batch, history);
  assert.match(prompt, /PR description/);
  assert.doesNotMatch(prompt, /summary-0/);
  assert.match(prompt, /summary-5/);
  assert.match(prompt, /1 comment, 1 commit/);
  assert.match(prompt, /2 comments, 2 commits/);
  assert.match(prompt, /Inline location: a\.ts:7/);
  assert.match(prompt, /Inline location: b\.ts\n/);
  assert.match(prompt, /Author: @carol/);
  const minimal = buildPrompt(payload());
  assert.doesNotMatch(minimal, /PR description/);
  assert.doesNotMatch(minimal, /recent automation changelog/);
});

test("PR comment workflow pauses retryable failures and always cleans its workdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-comment-retry-"));
  try {
    const posted: string[] = [];
    const setup = dependencies(root, {
      runAgent: async () => ({
        exitCode: 9,
        stdout: "capacity unavailable",
        stderr: "",
      }),
    });
    await prCommentWorkflow(setup.deps).handle(
      { kind: "pr_comment", id: "batch/unsafe", payload: payload() },
      context(root, posted),
    );
    assert.deepEqual(posted, []);
    assert.deepEqual(setup.calls, [
      "prompt:0",
      "prepare:batch_unsafe",
      "cleanup:false",
    ]);
    const state = JSON.parse(
      readFileSync(join(root, "state", "github", "owner", "repo.json"), "utf8"),
    );
    assert.equal(state.pendingCommentGroups["group-1"].retryAfterMs, 12_000);
    assert.equal(
      state.pendingCommentGroups["group-1"].lastError,
      "capacity unavailable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR comment workflow records non-retry failures that produce no changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-comment-nochange-"));
  try {
    const posted: string[] = [];
    const comments = [
      {
        key: "one",
        id: 1,
        kind: "review" as const,
        author: "alice",
        body: "one",
        createdAt: "1",
        review: { path: "a.ts", line: 1, diffHunk: "@@" },
      },
      {
        key: "two",
        id: 2,
        kind: "review" as const,
        author: "bob",
        body: "two",
        createdAt: "2",
        review: { path: "b.ts", line: 2, diffHunk: "@@" },
      },
      {
        key: "three",
        id: 3,
        kind: "review" as const,
        author: "bob",
        body: "three",
        createdAt: "3",
        review: { path: "c.ts", line: 3, diffHunk: "@@" },
      },
      {
        key: "four",
        id: 4,
        kind: "review" as const,
        author: "bob",
        body: "four",
        createdAt: "4",
        review: { path: "d.ts", line: 4, diffHunk: "@@" },
      },
      {
        key: "five",
        id: 5,
        kind: "review" as const,
        author: "bob",
        body: "five",
        createdAt: "5",
        review: { path: "e.ts", line: 5, diffHunk: "@@" },
      },
      {
        key: "six",
        id: 6,
        kind: "review" as const,
        author: "bob",
        body: "six",
        createdAt: "6",
        review: { path: "f.ts", line: 6, diffHunk: "@@" },
      },
      {
        key: "seven",
        id: 7,
        kind: "issue" as const,
        author: "bob",
        body: "seven",
        createdAt: "7",
      },
    ];
    const setup = dependencies(root, {
      runAgent: async () => ({
        exitCode: 2,
        stdout: "ordinary failure",
        stderr: "details",
      }),
    });
    await prCommentWorkflow(setup.deps).handle(
      {
        kind: "pr_comment",
        id: "batch",
        payload: payload({ attempts: 3, comments }),
      },
      context(root, posted),
    );
    assert.match(
      posted[0],
      /No changes produced for @alice, @bob's 7 comments/,
    );
    const state = JSON.parse(
      readFileSync(join(root, "state", "github", "owner", "repo.json"), "utf8"),
    );
    assert.match(
      state.prs["4"].commentBatchHistory[0].summary,
      /on a.ts, b.ts, c.ts, d.ts, e.ts and 1 more file/,
    );
    assert.match(
      state.prs["4"].commentBatchHistory[0].summary,
      /produced no commits/,
    );
    assert.equal(state.processedCommentKeys.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR comment workflow commits leftovers, pushes ahead branches, and reports singular/plural commits", async () => {
  for (const ahead of [1, 2]) {
    const root = mkdtempSync(
      join(tmpdir(), `agent-workflows-comment-push-${ahead}-`),
    );
    try {
      const posted: string[] = [];
      const setup = dependencies(root, {
        commitUncommittedChanges: () => true,
        commitsAhead: () => ahead,
      });
      await prCommentWorkflow(setup.deps).handle(
        { kind: "pr_comment", id: "batch", payload: payload() },
        context(root, posted),
      );
      assert.ok(setup.calls.includes("push"));
      assert.match(posted[0], ahead === 1 ? /1 commit\)\./ : /2 commits\)\./);
      const state = JSON.parse(
        readFileSync(
          join(root, "state", "github", "owner", "repo.json"),
          "utf8",
        ),
      );
      assert.match(
        state.prs["4"].commentBatchHistory[0].summary,
        new RegExp(`produced ${ahead} commit`),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
