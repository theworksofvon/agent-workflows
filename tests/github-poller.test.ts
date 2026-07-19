import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type { GitHubClient } from "../src/github/client.js";
import { githubPoller } from "../src/github/poller.js";

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
            number: 1,
            title: "Draft",
            body: null,
            headRef: "draft-branch",
            baseRef: "main",
            draft: true,
          },
          {
            number: 2,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
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
    } as unknown as GitHubClient;

    const poller = githubPoller({ config: makeConfig(root), client });
    const events = await poller.poll();

    assert.deepEqual(commentReads, [2, 2]);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.prNumber, 2);
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
            number: 1,
            title: "Was Draft",
            body: null,
            headRef: "draft-branch",
            baseRef: "main",
            draft,
          },
          {
            number: 2,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
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
    } as unknown as GitHubClient;

    const poller = githubPoller({ config: makeConfig(root), client });
    const firstPoll = await poller.poll();
    assert.deepEqual(
      firstPoll.map((event) => event.payload.prNumber),
      [2],
    );

    draft = false;
    const secondPoll = await poller.poll();
    assert.deepEqual(
      secondPoll.map((event) => event.payload.prNumber),
      [1],
    );
    assert.equal(secondPoll[0].payload.comments[0].id, 100);
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
            number: 1,
            title: "Ready",
            body: null,
            headRef: "ready-branch",
            baseRef: "main",
            draft: false,
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
        return [];
      },
    } as unknown as GitHubClient;

    const config = makeConfig(root);
    config.processExistingCommentsOnFirstRun = false;
    const poller = githubPoller({ config, client });

    assert.deepEqual(await poller.poll(), []);
    includeNewComment = true;
    const events = await poller.poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.comments[0].id, 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
