import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../../src/config.js";
import {
  pollRepos,
  type GitHubPollingClient,
} from "../../src/services/poll.js";
import {
  GitHubRepoStateStore,
  jsonFileState,
} from "../../src/adapters/state/json-file.js";

function makeConfig(root: string): Config {
  return {
    githubToken: "test-token",
    repos: [{ owner: "local-owner", repo: "sample-repo" }],
    pollIntervalSec: 60,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 1800,
    agentMaxAttempts: 5,
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    allowedAuthors: null,
    stateDir: join(root, "state"),
    zcodeBin: "zcode",
    claudeCodeBin: "claude",
    codexBin: "codex",
    keepWorkdirs: false,
  };
}

test("github poller skips draft PRs before reading comments", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-draft-"));
  try {
    const commentReads: number[] = [];
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "Draft",
            body: null,
            headRef: "draft-branch",
            baseRef: "main",
            draft: true,
            fromFork: false,
          },
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 2,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments(_repo: unknown, prNumber: number) {
        commentReads.push(prNumber);
        return [
          {
            id: 10,
            author: "reviewer",
            body: "please update this",
            createdAt: new Date().toISOString(),
          },
        ];
      },
      async listReviewComments(_repo: unknown, prNumber: number) {
        commentReads.push(prNumber);
        return [];
      },
    } satisfies GitHubPollingClient;

    const config = makeConfig(root);
    const state = jsonFileState(config);
    const poll = () => pollRepos({ config, client, state });
    const events = await poll();

    assert.deepEqual(commentReads, [2, 2]);
    assert.equal(events.length, 1);
    assert.equal(events[0].prNumber, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller processes old draft comments after PR becomes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-ready-"));
  try {
    let draft = true;
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "Was Draft",
            body: null,
            headRef: "draft-branch",
            baseRef: "main",
            draft,
            fromFork: false,
          },
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 2,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments(_repo: unknown, prNumber: number) {
        if (prNumber === 1) {
          return [
            {
              id: 100,
              author: "reviewer",
              body: "old draft comment",
              createdAt: new Date(1_000).toISOString(),
            },
          ];
        }
        return [
          {
            id: 105,
            author: "reviewer",
            body: "new ready comment",
            createdAt: new Date(2_000).toISOString(),
          },
        ];
      },
      async listReviewComments() {
        return [];
      },
    } satisfies GitHubPollingClient;

    const config = makeConfig(root);
    const state = jsonFileState(config);
    const poll = () => pollRepos({ config, client, state });
    const firstPoll = await poll();
    assert.deepEqual(
      firstPoll.map((event) => event.prNumber),
      [2],
    );

    draft = false;
    const secondPoll = await poll();
    assert.deepEqual(
      secondPoll.map((event) => event.prNumber),
      [1],
    );
    assert.equal(secondPoll[0].comments[0].id, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller skips existing comments on a new installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-bootstrap-"));
  try {
    let includeNewComment = false;
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments() {
        return [
          {
            id: 10,
            author: "reviewer",
            body: "existing comment",
            createdAt: new Date(1_000).toISOString(),
          },
          ...(includeNewComment
            ? [
                {
                  id: 11,
                  author: "reviewer",
                  body: "new comment",
                  createdAt: new Date(2_000).toISOString(),
                },
              ]
            : []),
        ];
      },
      async listReviewComments() {
        return [
          {
            id: includeNewComment ? 21 : 20,
            author: "reviewer",
            body: includeNewComment ? "new review" : "existing review",
            path: "a.ts",
            line: 1,
            originalLine: 1,
            diffHunk: "@@",
            createdAt: new Date(
              includeNewComment ? 2_000 : 1_000,
            ).toISOString(),
            reviewId: null,
          },
        ];
      },
    } satisfies GitHubPollingClient;

    const config = makeConfig(root);
    config.processExistingCommentsOnFirstRun = false;
    const state = jsonFileState(config);
    const poll = () => pollRepos({ config, client, state });

    assert.deepEqual(await poll(), []);
    includeNewComment = true;
    const events = await poll();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.comments[0].id),
      [11, 21],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller filters self, marker, bot, cursor, and processed comments and groups reviews", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-filters-"));
  try {
    const config = makeConfig(root);
    config.agentSelfUser = "AgentUser";
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "Ready",
            body: "body",
            headRef: "head",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments() {
        return [
          {
            id: 1,
            author: "reviewer",
            body: "<!-- agent-workflows:bot --> own",
            createdAt: "2020-01-01T00:00:00Z",
          },
          {
            id: 2,
            author: "agentuser",
            body: "own",
            createdAt: "2020-01-01T00:00:01Z",
          },
          {
            id: 3,
            author: "dependabot[bot]",
            body: "bot",
            createdAt: "2020-01-01T00:00:02Z",
          },
          {
            id: 4,
            author: "human",
            body: "conversation",
            createdAt: "2020-01-01T00:00:03Z",
          },
        ];
      },
      async listReviewComments() {
        return [
          {
            id: 10,
            author: "human",
            body: "<!-- agent-workflows:bot -->",
            path: "a.ts",
            line: null,
            originalLine: null,
            diffHunk: "@@",
            createdAt: "2020-01-01T00:00:04Z",
            reviewId: null,
          },
          {
            id: 11,
            author: "AGENTUSER",
            body: "own",
            path: "a.ts",
            line: null,
            originalLine: 4,
            diffHunk: "@@",
            createdAt: "2020-01-01T00:00:05Z",
            reviewId: null,
          },
          {
            id: 12,
            author: "human",
            body: "ungrouped",
            path: "a.ts",
            line: null,
            originalLine: 4,
            diffHunk: "@@",
            createdAt: "2020-01-01T00:00:06Z",
            reviewId: null,
          },
          {
            id: 13,
            author: "human",
            body: "grouped",
            path: "b.ts",
            line: 5,
            originalLine: 4,
            diffHunk: "@@",
            createdAt: "2020-01-01T00:00:07Z",
            reviewId: 99,
          },
        ];
      },
    } satisfies GitHubPollingClient;
    const state = jsonFileState(config);
    const poll = () => pollRepos({ config, client, state });
    const events = await poll();
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((payload) => payload.comments[0].id),
      [4, 12, 13],
    );
    assert.equal(events[1].comments[0].review?.line, 4);
    assert.equal(events[2].comments[0].review?.line, 5);
    assert.deepEqual(await poll(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller isolates repository failures and continues polling healthy repositories", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-errors-"));
  try {
    const config = makeConfig(root);
    config.repos = [
      { owner: "bad", repo: "repo" },
      { owner: "good", repo: "repo" },
    ];
    const client = {
      async listOpenPRs(repo: { owner: string }) {
        if (repo.owner === "bad") throw new Error("API unavailable");
        return [];
      },
      async listIssueComments() {
        return [];
      },
      async listReviewComments() {
        return [];
      },
    } satisfies GitHubPollingClient;
    assert.deepEqual(
      await pollRepos({ config, client, state: jsonFileState(config) }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller ignores processed issue and review keys even beyond their cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-processed-"));
  try {
    const config = makeConfig(root);
    const state = GitHubRepoStateStore.fromConfig(config, config.repos[0]);
    state.markBatchCompleted({
      repo: config.repos[0],
      prNumber: 1,
      prTitle: "PR",
      prBody: null,
      headRef: "head",
      baseRef: "main",
      batchId: "processed",
      groupKey: "processed",
      firstSeenAt: "now",
      lastSeenAt: "now",
      attempts: 1,
      comments: [
        {
          key: "local-owner/sample-repo#1:issue:100",
          id: 100,
          kind: "issue",
          author: "human",
          body: "done",
          createdAt: "now",
        },
        {
          key: "local-owner/sample-repo#1:review:200",
          id: 200,
          kind: "review",
          author: "human",
          body: "done",
          createdAt: "now",
        },
      ],
    });
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "PR",
            body: null,
            headRef: "head",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments() {
        return [{ id: 100, author: "human", body: "done", createdAt: "now" }];
      },
      async listReviewComments() {
        return [
          {
            id: 200,
            author: "human",
            body: "done",
            path: "a.ts",
            line: null,
            originalLine: null,
            diffHunk: "@@",
            createdAt: "now",
            reviewId: null,
          },
        ];
      },
    } satisfies GitHubPollingClient;
    assert.deepEqual(
      await pollRepos({ config, client, state: jsonFileState(config) }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("github poller drops authors outside the allowlist but still advances the cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-poller-allow-"));
  try {
    const config = makeConfig(root);
    config.allowedAuthors = ["alice"];
    const client = {
      async listOpenPRs() {
        return [
          {
            repo: { owner: "local-owner", repo: "sample-repo" },
            number: 1,
            title: "PR",
            body: null,
            headRef: "head",
            baseRef: "main",
            draft: false,
            fromFork: false,
          },
        ];
      },
      async listIssueComments() {
        return [
          { id: 5, author: "Alice", body: "mine", createdAt: "now" },
          { id: 6, author: "bob", body: "not allowed", createdAt: "now" },
        ];
      },
      async listReviewComments() {
        return [];
      },
    } satisfies GitHubPollingClient;
    const state = jsonFileState(config);
    const batches = await pollRepos({ config, client, state });
    assert.deepEqual(
      batches.flatMap((batch) => batch.comments.map((c) => c.author)),
      ["Alice"],
    );
    assert.equal(state(config.repos[0]).getIssueCommentCursor(1), 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
