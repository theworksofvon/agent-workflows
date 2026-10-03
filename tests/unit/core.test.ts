import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../../src/config.js";
import {
  GitHubClient,
  MARKER_TAG,
  type GitHubApi,
} from "../../src/adapters/github/octokit.js";
import type { GitPort } from "../../src/adapters/git/git.interface.js";
import { getAgent } from "../../src/adapters/agent/registry.js";
import { jsonFileState } from "../../src/adapters/state/json-file.js";
import type { RepoRef } from "../../src/domain/events.js";
import { createLogger } from "../../src/log.js";
import {
  defaultCliDependencies,
  printHelp,
  printReviewResult,
  runCli,
  runEntryPoint,
  runReviewCommand,
  runWebhooksCommand,
  type CliDependencies,
} from "../../src/main.js";
import type {
  ReviewRunResult,
  ReviewOptions,
} from "../../src/services/review-pr.js";

const CONFIG_KEYS = [
  "GITHUB_TOKEN",
  "REPOS",
  "POLL_INTERVAL_SEC",
  "COMMENT_BATCH_WINDOW_SEC",
  "COMMENT_BATCH_MIN_COMMENTS",
  "COMMENT_BATCH_MAX_WAIT_SEC",
  "PR_CONTEXT_HISTORY_LIMIT",
  "COMMENT_BATCH_HISTORY_LIMIT",
  "PROCESSED_COMMENT_KEY_LIMIT",
  "AGENT_RETRY_DELAY_SEC",
  "AGENT_MAX_ATTEMPTS",
  "AGENT",
  "REVIEW_ADVERSARIAL_MODE",
  "REVIEW_ADVERSARIAL_AGENT",
  "PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN",
  "AGENT_SELF_USER",
  "STATE_DIR",
  "ZCODE_BIN",
  "CLAUDE_CODE_BIN",
  "CODEX_BIN",
  "KEEP_WORKDIRS",
  "HOST",
  "PORT",
  "WEBHOOK_SECRET",
  "PUBLIC_URL",
  "TAILSCALE_FUNNEL",
  "MAX_CONCURRENT_RUNS",
  "AUTO_REVIEW",
] as const;

function withEnv(
  values: Record<string, string | undefined>,
  fn: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeConfig(root = tmpdir()): Config {
  return {
    githubToken: "test-token",
    repos: [{ owner: "owner", repo: "repo" }],
    pollIntervalSec: 5,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 0,
    agentMaxAttempts: 5,
    agent: "codex",
    reviewAdversarialMode: "auto",
    reviewAdversarialAgent: "claude-code",
    processExistingCommentsOnFirstRun: false,
    agentSelfUser: null,
    allowedAuthors: null,
    stateDir: join(root, "state"),
    zcodeBin: "zcode-test",
    claudeCodeBin: "claude-test",
    codexBin: "codex-test",
    keepWorkdirs: false,
    host: "127.0.0.1",
    port: 3773,
    webhookSecret: null,
    publicUrl: null,
    tailscaleFunnel: false,
    maxConcurrentRuns: 3,
    autoReview: false,
  };
}

test("loadConfig parses defaults, explicit values, repositories, and optional daemon repos", () => {
  withEnv(
    { GITHUB_TOKEN: " token ", REPOS: " owner/one, ,owner/two ", AGENT: " " },
    () => {
      const config = loadConfig();
      assert.equal(config.githubToken, "token");
      assert.deepEqual(config.repos, [
        { owner: "owner", repo: "one" },
        { owner: "owner", repo: "two" },
      ]);
      assert.equal(config.agent, "codex");
      assert.equal(config.reviewAdversarialAgent, "codex");
      assert.equal(config.agentSelfUser, null);
      assert.equal(config.allowedAuthors, null);
      assert.equal(config.processExistingCommentsOnFirstRun, false);
      assert.equal(config.keepWorkdirs, false);
      assert.equal(config.stateDir, resolve("./state"));
      assert.equal(config.pollIntervalSec, 300);
      assert.equal(config.host, "127.0.0.1");
      assert.equal(config.port, 3773);
      assert.equal(config.webhookSecret, null);
      assert.equal(config.publicUrl, null);
      assert.equal(config.tailscaleFunnel, false);
      assert.equal(config.maxConcurrentRuns, 3);
      assert.equal(config.autoReview, false);
    },
  );

  const root = mkdtempSync(join(tmpdir(), "agent-workflows-config-"));
  try {
    withEnv(
      {
        GITHUB_TOKEN: "token",
        REPOS: "owner/repo",
        POLL_INTERVAL_SEC: "5",
        COMMENT_BATCH_WINDOW_SEC: "0",
        COMMENT_BATCH_MIN_COMMENTS: "3",
        COMMENT_BATCH_MAX_WAIT_SEC: "1.5",
        PR_CONTEXT_HISTORY_LIMIT: "0",
        COMMENT_BATCH_HISTORY_LIMIT: "0",
        PROCESSED_COMMENT_KEY_LIMIT: "0",
        AGENT_RETRY_DELAY_SEC: "0",
        AGENT_MAX_ATTEMPTS: "1",
        AGENT: "zcode",
        REVIEW_ADVERSARIAL_MODE: "always",
        REVIEW_ADVERSARIAL_AGENT: "claude-code",
        PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN: "true",
        AGENT_SELF_USER: " bot ",
        ALLOWED_AUTHORS: "alice, Bob",
        STATE_DIR: root,
        ZCODE_BIN: " z ",
        CLAUDE_CODE_BIN: " c ",
        CODEX_BIN: " x ",
        KEEP_WORKDIRS: "true",
        HOST: "0.0.0.0",
        PORT: "8080",
        WEBHOOK_SECRET: "s3cret",
        PUBLIC_URL: "https://hooks.example.com",
        TAILSCALE_FUNNEL: "true",
        MAX_CONCURRENT_RUNS: "1",
        AUTO_REVIEW: "true",
      },
      () => {
        const config = loadConfig({ requireRepos: true });
        assert.equal(config.commentBatchMinComments, 3);
        assert.equal(config.commentBatchMaxWaitSec, 1.5);
        assert.equal(config.reviewAdversarialMode, "always");
        assert.equal(config.reviewAdversarialAgent, "claude-code");
        assert.equal(config.agentSelfUser, "bot");
        assert.deepEqual(config.allowedAuthors, ["alice", "Bob"]);
        assert.equal(config.processExistingCommentsOnFirstRun, true);
        assert.equal(config.keepWorkdirs, true);
        assert.equal(config.zcodeBin, "z");
        assert.equal(config.host, "0.0.0.0");
        assert.equal(config.port, 8080);
        assert.equal(config.webhookSecret, "s3cret");
        assert.equal(config.publicUrl, "https://hooks.example.com");
        assert.equal(config.tailscaleFunnel, true);
        assert.equal(config.maxConcurrentRuns, 1);
        assert.equal(config.autoReview, true);
      },
    );
    withEnv(
      { GITHUB_TOKEN: "token", REPOS: "", REVIEW_ADVERSARIAL_MODE: "off" },
      () => {
        assert.deepEqual(loadConfig({ requireRepos: false }).repos, []);
      },
    );
    withEnv({ GITHUB_TOKEN: "token" }, () => {
      assert.deepEqual(loadConfig({ requireRepos: false }).repos, []);
    });
    withEnv(
      {
        GITHUB_TOKEN: "token",
        PUBLIC_URL: "http://localhost:3773",
        WEBHOOK_SECRET: "s",
      },
      () => {
        assert.equal(
          loadConfig({ requireRepos: false }).publicUrl,
          "http://localhost:3773",
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects every invalid required, repository, enum, and numeric value", () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ REPOS: "owner/repo" }, /GITHUB_TOKEN/],
    [{ GITHUB_TOKEN: "   ", REPOS: "owner/repo" }, /GITHUB_TOKEN/],
    [{ GITHUB_TOKEN: "x", REPOS: "owner" }, /Invalid repo slug/],
    [{ GITHUB_TOKEN: "x", REPOS: "/repo" }, /Invalid repo slug/],
    [{ GITHUB_TOKEN: "x", REPOS: "owner/" }, /Invalid repo slug/],
    [{ GITHUB_TOKEN: "x", REPOS: "a/b/c" }, /Invalid repo slug/],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        REVIEW_ADVERSARIAL_MODE: "sometimes",
      },
      /must be one of/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", POLL_INTERVAL_SEC: "NaN" },
      /POLL_INTERVAL_SEC/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", POLL_INTERVAL_SEC: "4" },
      /POLL_INTERVAL_SEC/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_WINDOW_SEC: "NaN",
      },
      /COMMENT_BATCH_WINDOW_SEC/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_WINDOW_SEC: "-1",
      },
      /COMMENT_BATCH_WINDOW_SEC/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_MIN_COMMENTS: "1.5",
      },
      /COMMENT_BATCH_MIN_COMMENTS/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_MIN_COMMENTS: "0",
      },
      /COMMENT_BATCH_MIN_COMMENTS/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_MAX_WAIT_SEC: "NaN",
      },
      /COMMENT_BATCH_MAX_WAIT_SEC/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_MAX_WAIT_SEC: "-1",
      },
      /COMMENT_BATCH_MAX_WAIT_SEC/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PR_CONTEXT_HISTORY_LIMIT: "1.5",
      },
      /PR_CONTEXT_HISTORY_LIMIT/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PR_CONTEXT_HISTORY_LIMIT: "-1",
      },
      /PR_CONTEXT_HISTORY_LIMIT/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_HISTORY_LIMIT: "1.5",
      },
      /COMMENT_BATCH_HISTORY_LIMIT/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        COMMENT_BATCH_HISTORY_LIMIT: "-1",
      },
      /COMMENT_BATCH_HISTORY_LIMIT/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PROCESSED_COMMENT_KEY_LIMIT: "1.5",
      },
      /PROCESSED_COMMENT_KEY_LIMIT/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PROCESSED_COMMENT_KEY_LIMIT: "-1",
      },
      /PROCESSED_COMMENT_KEY_LIMIT/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", AGENT_RETRY_DELAY_SEC: "NaN" },
      /AGENT_RETRY_DELAY_SEC/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", AGENT_RETRY_DELAY_SEC: "-1" },
      /AGENT_RETRY_DELAY_SEC/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", AGENT_MAX_ATTEMPTS: "1.5" },
      /AGENT_MAX_ATTEMPTS/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", AGENT_MAX_ATTEMPTS: "0" },
      /AGENT_MAX_ATTEMPTS/,
    ],
    [{ GITHUB_TOKEN: "x", REPOS: "owner/repo", PORT: "NaN" }, /PORT/],
    [{ GITHUB_TOKEN: "x", REPOS: "owner/repo", PORT: "80.5" }, /PORT/],
    [{ GITHUB_TOKEN: "x", REPOS: "owner/repo", PORT: "0" }, /PORT/],
    [{ GITHUB_TOKEN: "x", REPOS: "owner/repo", PORT: "65536" }, /PORT/],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", MAX_CONCURRENT_RUNS: "1.5" },
      /MAX_CONCURRENT_RUNS/,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", MAX_CONCURRENT_RUNS: "0" },
      /MAX_CONCURRENT_RUNS/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PUBLIC_URL: "ftp://example.com",
        WEBHOOK_SECRET: "s",
      },
      /PUBLIC_URL must start with/,
    ],
    [
      {
        GITHUB_TOKEN: "x",
        REPOS: "owner/repo",
        PUBLIC_URL: "https://example.com",
      },
      /WEBHOOK_SECRET is required when webhooks are enabled\./,
    ],
    [
      { GITHUB_TOKEN: "x", REPOS: "owner/repo", TAILSCALE_FUNNEL: "true" },
      /WEBHOOK_SECRET is required when webhooks are enabled\./,
    ],
    [{ GITHUB_TOKEN: "x", REPOS: "" }, /REPOS must list/],
  ];
  for (const [env, expected] of cases) {
    withEnv(env, () => assert.throws(() => loadConfig(), expected));
  }
});

function fakeGitHub(calls: Array<[string, unknown]>): GitHubApi {
  return {
    rest: {
      pulls: {
        list: async (args: unknown) => {
          calls.push(["list", args]);
          return {
            data: [
              {
                number: 1,
                title: "One",
                body: null,
                head: { ref: "head" },
                base: { ref: "base" },
                draft: undefined,
              },
              {
                number: 2,
                title: "Two",
                body: "body",
                head: { ref: "h2", repo: { full_name: "fork/repo" } },
                base: { ref: "b2", repo: { full_name: "owner/repo" } },
                draft: true,
              },
              {
                number: 6,
                title: "Six",
                body: null,
                head: { ref: "h6", repo: null },
                base: { ref: "b6", repo: { full_name: "owner/repo" } },
                draft: false,
              },
            ],
          };
        },
        listReviewComments: async (args: unknown) => {
          calls.push(["review-comments", args]);
          return {
            data: [
              {
                id: 3,
                user: null,
                body: null,
                path: "a.ts",
                line: undefined,
                original_line: undefined,
                diff_hunk: "@@",
                created_at: "2020-01-01T00:00:00Z",
                pull_request_review_id: undefined,
              },
              {
                id: 4,
                user: { login: "reviewer" },
                body: "fix",
                path: "b.ts",
                line: 8,
                original_line: 7,
                diff_hunk: "@@",
                created_at: "2021-01-01T00:00:00Z",
                pull_request_review_id: 9,
              },
            ],
          };
        },
        get: async (args: unknown) => {
          calls.push(["get", args]);
          return {
            data: {
              number: 5,
              title: "PR",
              body: null,
              head: { ref: "feature", repo: { full_name: "owner/repo" } },
              base: { ref: "main", repo: { full_name: "owner/repo" } },
              draft: undefined,
            },
          };
        },
        listFiles: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          calls.push(["create-review", args]);
        },
        createReplyForReviewComment: async (args: unknown) => {
          calls.push(["reply", args]);
        },
      },
      issues: {
        listComments: async (args: unknown) => {
          calls.push(["issue-comments", args]);
          return {
            data: [
              {
                id: 1,
                user: null,
                body: null,
                created_at: "2020-01-01T00:00:00Z",
              },
              {
                id: 2,
                user: { login: "author" },
                body: "hello",
                created_at: "2021-01-01T00:00:00Z",
              },
            ],
          };
        },
        createComment: async (args: unknown) => {
          calls.push(["create-comment", args]);
        },
      },
      repos: {
        listWebhooks: async (args: unknown) => {
          calls.push(["list-hooks", args]);
          return {
            data: [
              {
                id: 1,
                events: ["issue_comment"],
                active: true,
                config: { url: "https://x.test/hook" },
              },
              { id: 2, events: [], active: false },
            ],
          };
        },
        createWebhook: async (args: unknown) => {
          calls.push(["create-hook", args]);
          return {
            data: {
              id: 3,
              events: ["pull_request"],
              active: true,
              config: { url: "https://x.test/new" },
            },
          };
        },
        updateWebhook: async (args: unknown) => {
          calls.push(["update-hook", args]);
          return {
            data: {
              id: 3,
              events: ["pull_request"],
              active: true,
              config: { url: "https://x.test/new" },
            },
          };
        },
        listWebhookDeliveries: async (args: unknown) => {
          calls.push(["hook-deliveries", args]);
          return {
            data: [
              {
                id: 10,
                event: "ping",
                status_code: 200,
                delivered_at: "2021-01-01T00:00:00Z",
                redelivery: false,
              },
            ],
          };
        },
      },
    },
    paginate: async (_method: unknown, args: unknown) => {
      calls.push(["files", args]);
      return [
        {
          filename: "a.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: undefined,
        },
        {
          filename: "b.ts",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "+x",
        },
      ];
    },
  };
}

test("GitHubClient normalizes responses and sends exact Octokit arguments", async () => {
  const calls: Array<[string, unknown]> = [];
  const fake = fakeGitHub(calls);
  const client = new GitHubClient("unused", { octokit: fake });
  const ref = { owner: "owner", repo: "repo" };
  assert.equal(MARKER_TAG, "<!-- agent-workflows:bot -->");
  assert.deepEqual(await client.listOpenPRs(ref), [
    {
      repo: ref,
      number: 1,
      title: "One",
      body: null,
      headRef: "head",
      baseRef: "base",
      draft: false,
      fromFork: true,
    },
    {
      repo: ref,
      number: 2,
      title: "Two",
      body: "body",
      headRef: "h2",
      baseRef: "b2",
      draft: true,
      fromFork: true,
    },
    {
      repo: ref,
      number: 6,
      title: "Six",
      body: null,
      headRef: "h6",
      baseRef: "b6",
      draft: false,
      fromFork: true,
    },
  ]);
  assert.equal((await client.listIssueComments(ref, 3)).length, 2);
  assert.deepEqual((await client.listIssueComments(ref, 3))[1], {
    id: 2,
    author: "author",
    body: "hello",
    createdAt: "2021-01-01T00:00:00Z",
  });
  const allReviews = await client.listReviewComments(ref, 3);
  assert.deepEqual(allReviews[0], {
    id: 3,
    author: "unknown",
    body: "",
    path: "a.ts",
    line: null,
    originalLine: null,
    diffHunk: "@@",
    createdAt: "2020-01-01T00:00:00Z",
    reviewId: null,
  });
  assert.equal(allReviews[1].reviewId, 9);
  await client.createComment(ref, 3, "body");
  assert.deepEqual(await client.getPullRequest(ref, 5), {
    repo: ref,
    number: 5,
    title: "PR",
    body: null,
    headRef: "feature",
    baseRef: "main",
    draft: false,
    fromFork: false,
  });
  assert.deepEqual(await client.listPullRequestFiles(ref, 5), [
    {
      path: "a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: null,
    },
    { path: "b.ts", status: "added", additions: 1, deletions: 0, patch: "+x" },
  ]);
  await client.createPullRequestReview({
    repo: ref,
    prNumber: 5,
    body: "summary",
    comments: [{ path: "a.ts", line: 2, body: "finding" }],
  });
  assert.deepEqual(calls.find(([name]) => name === "list")?.[1], {
    owner: "owner",
    repo: "repo",
    state: "open",
    per_page: 100,
  });
  assert.deepEqual(calls.find(([name]) => name === "create-comment")?.[1], {
    owner: "owner",
    repo: "repo",
    issue_number: 3,
    body: "body",
  });
  assert.deepEqual(calls.find(([name]) => name === "create-review")?.[1], {
    owner: "owner",
    repo: "repo",
    pull_number: 5,
    event: "COMMENT",
    body: "summary",
    comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "finding" }],
  });
  assert.ok(new GitHubClient("token").octokit);
});

test("github client passes review replies and webhook operations through", async () => {
  const calls: Array<[string, unknown]> = [];
  const github = fakeGitHub(calls);
  const client = new GitHubClient("unused", { octokit: github });
  const ref = { owner: "owner", repo: "repo" };
  const hookArgs = { url: "https://x.test/new", secret: "s", events: ["a"] };
  const hookBody = {
    events: ["a"],
    active: true,
    config: { url: "https://x.test/new", content_type: "json", secret: "s" },
  };
  const argsFor = (name: string) => calls.find(([n]) => n === name)?.[1];

  await client.replyToReviewComment(ref, 5, 77, "thanks");
  assert.deepEqual(argsFor("reply"), {
    owner: "owner",
    repo: "repo",
    pull_number: 5,
    comment_id: 77,
    body: "thanks",
  });

  assert.deepEqual(await client.listHooks(ref), [
    {
      id: 1,
      url: "https://x.test/hook",
      events: ["issue_comment"],
      active: true,
    },
    { id: 2, url: "", events: [], active: false },
  ]);
  assert.deepEqual(argsFor("list-hooks"), {
    owner: "owner",
    repo: "repo",
    per_page: 100,
  });

  const created = await client.createHook(ref, hookArgs);
  assert.deepEqual(created, {
    id: 3,
    url: "https://x.test/new",
    events: ["pull_request"],
    active: true,
  });
  assert.deepEqual(argsFor("create-hook"), {
    owner: "owner",
    repo: "repo",
    ...hookBody,
  });

  await client.updateHook(ref, 3, hookArgs);
  assert.deepEqual(argsFor("update-hook"), {
    owner: "owner",
    repo: "repo",
    hook_id: 3,
    ...hookBody,
  });

  assert.deepEqual(await client.listHookDeliveries(ref, 3), [
    {
      id: 10,
      event: "ping",
      statusCode: 200,
      deliveredAt: "2021-01-01T00:00:00Z",
      redelivery: false,
    },
  ]);
  assert.deepEqual(argsFor("hook-deliveries"), {
    owner: "owner",
    repo: "repo",
    hook_id: 3,
    per_page: 30,
  });
});

test("agent registry routes known entries and rejects unknown agents", () => {
  const config = makeConfig();
  assert.equal(getAgent("codex", config).name, "codex");
  assert.equal(getAgent("claude-code", config).name, "claude-code");
  assert.equal(getAgent("zcode", config).name, "zcode");
  assert.throws(() => getAgent("missing", config), /Unknown agent adapter/);
});

function reviewResult(
  overrides: Partial<ReviewRunResult> = {},
): ReviewRunResult {
  return {
    target: { repo: { owner: "owner", repo: "repo" }, prNumber: 7 },
    dryRun: true,
    review: { summary: "summary", findings: [] },
    newFindings: [],
    skippedDuplicateFindings: 0,
    skippedUnpostableFindings: 0,
    adversarialRan: false,
    adversarialReasons: ["disabled"],
    ...overrides,
  };
}

function fakeCli(overrides: Partial<CliDependencies> = {}): {
  dependencies: CliDependencies;
  lines: string[];
  signals: Map<string, () => void>;
  calls: string[];
} {
  const lines: string[] = [];
  const signals = new Map<string, () => void>();
  const calls: string[] = [];
  const config = makeConfig();
  const dependencies: CliDependencies = {
    loadConfig: (options) => {
      calls.push(`config:${options.requireRepos}`);
      return config;
    },
    createClient: () => ({}) as GitHubClient,
    getAgent: (name) => ({
      name,
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    createPoll: () => async () => [],
    createDaemon: () => ({
      async start() {
        calls.push("started");
      },
      async stop() {
        calls.push("stopped");
      },
      dispatchEvents() {},
      async idle() {},
    }),
    reviewPullRequest: async () => {
      calls.push("reviewed");
      return reviewResult();
    },
    tailscale: {
      async funnelOn() {
        calls.push("funnelOn");
        return "https://box.ts.net";
      },
      async funnelOff() {
        calls.push("funnelOff");
      },
      async currentUrl() {
        calls.push("currentUrl");
        return "https://box.ts.net";
      },
    },
    installWebhooks: async ({ publicUrl }) => [
      {
        repo: { owner: "owner", repo: "repo" },
        action: "created",
        hookId: 123,
        url: `${publicUrl}/webhooks/github`,
      },
    ],
    webhookStatus: async ({ publicUrl }) => [
      {
        repo: { owner: "owner", repo: "repo" },
        hookId: 5,
        url: `${publicUrl}/webhooks/github`,
        deliveries: Array.from({ length: 12 }, (_, i) => ({
          id: i,
          event: "issue_comment",
          statusCode: 202,
          deliveredAt: `2026-10-02T00:00:${String(i).padStart(2, "0")}Z`,
          redelivery: false,
        })),
      },
      {
        repo: { owner: "owner", repo: "other" },
        hookId: null,
        url: "",
        deliveries: [],
      },
    ],
    onSignal: (signal, listener) => {
      signals.set(signal, listener);
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
    },
    writeLine: (line) => {
      lines.push(line);
    },
    ...overrides,
  };
  return { dependencies, lines, signals, calls };
}

test("CLI help, daemon routing, signal lifecycle, and entrypoint fatal handling are deterministic", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const fake = fakeCli();
    await runCli([flag], fake.dependencies);
    assert.match(fake.lines[0], /Usage:/);
  }
  for (const flag of ["--help", "-h", "help"]) {
    const fake = fakeCli();
    await runCli(["review", flag], fake.dependencies);
    assert.match(fake.lines[0], /Commands:/);
  }
  const daemon = fakeCli();
  await runCli([], daemon.dependencies);
  assert.deepEqual(daemon.calls.slice(0, 2), ["config:true", "started"]);
  daemon.signals.get("SIGINT")?.();
  await new Promise((done) => setImmediate(done));
  daemon.signals.get("SIGTERM")?.();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(daemon.calls.slice(-4), [
    "stopped",
    "exit:0",
    "stopped",
    "exit:0",
  ]);
  const routedReview = fakeCli();
  await runCli(["review", "owner/repo#7"], routedReview.dependencies);
  assert.ok(routedReview.calls.includes("reviewed"));

  assert.equal(
    await runEntryPoint("file:///entry.js", ["node"], fakeCli().dependencies),
    false,
  );
  assert.equal(
    await runEntryPoint(
      "file:///entry.js",
      ["node", "/other.js"],
      fakeCli().dependencies,
    ),
    false,
  );
  const success = fakeCli();
  assert.equal(
    await runEntryPoint(
      "file:///entry.js",
      ["node", "/entry.js", "--help"],
      success.dependencies,
    ),
    true,
  );
  const fatal = fakeCli({
    loadConfig: () => {
      throw new Error("fatal");
    },
  });
  assert.equal(
    await runEntryPoint(
      "file:///entry.js",
      ["node", "/entry.js"],
      fatal.dependencies,
    ),
    true,
  );
  assert.ok(fatal.calls.includes("exit:1"));
  const nonError = fakeCli({
    loadConfig: () => {
      throw "fatal-string";
    },
  });
  await runEntryPoint(
    "file:///entry.js",
    ["node", "/entry.js"],
    nonError.dependencies,
  );
  assert.ok(nonError.calls.includes("exit:1"));
});

test("review CLI validates flags, selects adversarial policy, and prints every result form", async () => {
  const invalid: Array<[string[], RegExp]> = [
    [["owner/repo#1", "--wat"], /Unknown/],
    [[], /Usage/],
    [["owner/repo#1", "owner/repo#2"], /accepts one/],
    [["owner/repo#1", "--post", "--dry-run"], /either --post/],
    [
      ["owner/repo#1", "--adversarial", "--no-adversarial"],
      /either --adversarial/,
    ],
  ];
  for (const [args, expected] of invalid) {
    await assert.rejects(
      () => runReviewCommand(args, fakeCli().dependencies),
      expected,
    );
  }

  const observed: ReviewOptions[] = [];
  const make = (mode: Config["reviewAdversarialMode"]) => {
    const config = makeConfig();
    config.reviewAdversarialMode = mode;
    return fakeCli({
      loadConfig: () => config,
      reviewPullRequest: async (options) => {
        observed.push(options);
        return reviewResult();
      },
    });
  };
  await runReviewCommand(["owner/repo#7"], make("auto").dependencies);
  await runReviewCommand(
    ["owner/repo#7", "--adversarial", "--post"],
    make("off").dependencies,
  );
  await runReviewCommand(
    ["owner/repo#7", "--no-adversarial", "--dry-run"],
    make("always").dependencies,
  );
  assert.deepEqual(
    observed.map((item) => [
      item.adversarialMode,
      item.post,
      item.adversarialAgent?.name,
    ]),
    [
      ["auto", false, "claude-code"],
      ["always", true, "claude-code"],
      ["off", false, undefined],
    ],
  );

  const lines: string[] = [];
  printReviewResult(
    reviewResult({
      dryRun: false,
      adversarialRan: true,
      adversarialReasons: ["large-diff"],
      skippedDuplicateFindings: 2,
      skippedUnpostableFindings: 1,
      newFindings: [
        { path: "src/a.ts", line: 4, severity: "high", body: "Fix it." },
      ],
    }),
    (line) => lines.push(line),
  );
  assert.match(lines.join("\n"), /Review posted/);
  assert.match(lines.join("\n"), /Adversarial review: ran/);
  assert.match(lines.join("\n"), /Skipped duplicate/);
  assert.match(lines.join("\n"), /src\/a.ts:4/);
  const empty: string[] = [];
  printReviewResult(reviewResult({ skippedUnpostableFindings: 2 }), (line) =>
    empty.push(line),
  );
  assert.equal(empty.at(-1), "No new actionable findings.");
  const help: string[] = [];
  printHelp((line) => help.push(line));
  assert.match(help[0], /agent-workflows/);
});

test("default CLI factories construct local runtime objects without external calls", async () => {
  const config = makeConfig();
  const client = defaultCliDependencies.createClient("token");
  const agent = defaultCliDependencies.getAgent("codex", config);
  const poll = defaultCliDependencies.createPoll({
    config: { ...config, repos: [] },
    client,
  });
  const daemon = defaultCliDependencies.createDaemon({
    config,
    poll,
    client,
    agent,
  });
  assert.ok(client.octokit);
  assert.equal(agent.name, "codex");
  assert.deepEqual(await poll(), []);
  assert.equal(typeof daemon.start, "function");
  assert.equal(typeof defaultCliDependencies.reviewPullRequest, "function");
});

test("default daemon wires batches to feedback handling and ready PRs to posting reviews", async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-wire-"));
  try {
    for (const mode of ["auto", "off"] as const) {
      const config = {
        ...makeConfig(root),
        autoReview: true,
        reviewAdversarialMode: mode,
      };
      const seen: string[] = [];
      const client = {
        async getPullRequest() {
          seen.push("review");
          throw new Error("stop review");
        },
        async createComment() {
          seen.push("comment");
        },
        async replyToReviewComment() {},
      } as unknown as GitHubClient;
      const git = {
        prepareWorkdir() {
          seen.push("workdir");
          throw new Error("stop feedback");
        },
      } as unknown as GitPort;
      const daemon = defaultCliDependencies.createDaemon({
        config,
        poll: async () => [],
        client,
        agent: defaultCliDependencies.getAgent("codex", config),
        git,
      });
      const repo = { owner: "owner", repo: "repo" };
      daemon.dispatchEvents(
        [
          {
            kind: "pull_request_ready",
            pr: {
              repo,
              number: 7,
              title: "t",
              body: null,
              headRef: "h",
              baseRef: "main",
              draft: false,
              fromFork: false,
            },
          },
        ],
        [
          {
            repo,
            prNumber: 7,
            prTitle: "t",
            prBody: null,
            headRef: "h",
            baseRef: "main",
            batchId: `b-${mode}`,
            groupKey: "g",
            firstSeenAt: "",
            lastSeenAt: "",
            attempts: 0,
            comments: [],
          },
        ],
      );
      await daemon.idle();
      assert.ok(seen.includes("review"), mode);
      assert.ok(seen.includes("workdir"), mode);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default daemon serves webhooks only when a public route is configured, through the shared state", async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-hooks-"));
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    const cases: Array<[Partial<Config>, boolean]> = [
      [{}, false],
      [{ publicUrl: "https://hooks.example" }, true],
      [{ tailscaleFunnel: true }, true],
    ];
    for (const [over, enabled] of cases) {
      lines.length = 0;
      const config: Config = {
        ...makeConfig(root),
        webhookSecret: "s",
        port: 0,
        // No ready batch, so feedback handling never opens state on its own.
        allowedAuthors: ["someone-else"],
        ...over,
      };
      const opened: RepoRef[] = [];
      const shared = jsonFileState(config);
      const daemon = defaultCliDependencies.createDaemon({
        config,
        poll: async () => [],
        client: {} as GitHubClient,
        agent: defaultCliDependencies.getAgent("codex", config),
        git: {
          prepareWorkdir() {
            throw new Error("stop feedback");
          },
        } as unknown as GitPort,
        state: (repo) => {
          opened.push(repo);
          return shared(repo);
        },
      });
      await daemon.start();
      try {
        const url = /"url":"([^"]+)"/.exec(
          lines.find((line) => line.includes("webhook listener started")) ?? "",
        )?.[1];
        assert.equal(url !== undefined, enabled, JSON.stringify(over));
        if (!url) continue;
        const body = JSON.stringify({
          action: "created",
          repository: { name: "repo", owner: { login: "owner" } },
          comment: {
            id: 5,
            user: { login: "alice" },
            body: "fix",
            created_at: "2026-01-01T00:00:00Z",
            path: "a.ts",
            line: 3,
            original_line: 3,
            diff_hunk: "@@",
            pull_request_review_id: 9,
          },
          pull_request: {
            number: 4,
            title: "T",
            body: null,
            draft: false,
            head: { ref: "f", repo: { full_name: "owner/repo" } },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
          },
        });
        const res = await fetch(`${url}/webhooks/github`, {
          method: "POST",
          headers: {
            "x-github-delivery": `d-${JSON.stringify(over)}`,
            "x-github-event": "pull_request_review_comment",
            "x-hub-signature-256":
              "sha256=" + createHmac("sha256", "s").update(body).digest("hex"),
          },
          body,
        });
        assert.equal(res.status, 202);
        assert.deepEqual(await res.json(), { reason: "accepted" });
        assert.deepEqual(opened, [{ owner: "owner", repo: "repo" }]);
        await daemon.idle();
        assert.equal(opened.length, 1);
      } finally {
        await daemon.stop();
      }
    }
  } finally {
    console.log = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI public helpers retain safe default dependencies on validation/help paths", async () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    printHelp();
    printReviewResult(reviewResult());
    await runCli(["--help"]);
    await assert.rejects(() => runReviewCommand([]), /Usage/);
    assert.ok(lines.some((line) => line.includes("Usage:")));
    assert.ok(
      lines.some((line) => line.includes("No new actionable findings")),
    );
  } finally {
    console.log = original;
  }
});

test("logger honors thresholds and formats messages with and without metadata", () => {
  const original = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const output: string[] = [];
  console.debug =
    console.log =
    console.warn =
    console.error =
      (line: string) => output.push(line);
  try {
    const debug = createLogger("debug");
    debug.debug("debug");
    debug.info("info", {});
    debug.warn("warn", { value: 1 });
    debug.error("error");
    const errorsOnly = createLogger("error");
    errorsOnly.debug("hidden");
    errorsOnly.info("hidden");
    errorsOnly.warn("hidden");
    errorsOnly.error("visible", { ok: true });
    assert.equal(output.length, 5);
    assert.match(output[0], /\[DEBUG\] debug$/);
    assert.match(output[2], /\{"value":1\}/);
    assert.match(output[4], /visible/);
  } finally {
    console.debug = original.debug;
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});

test("review severity runtime contract exposes the parser's accepted values", async () => {
  assert.deepEqual(
    (await import("../../src/domain/decisions.js")).REVIEW_SEVERITIES,
    ["critical", "high", "medium", "low"],
  );
});

test("webhooks CLI resolves the public URL and prints install and status lines", async () => {
  const withUrl = { ...makeConfig(), publicUrl: "https://hooks.example.com" };
  const install = fakeCli({ loadConfig: () => withUrl });
  await runCli(["webhooks", "install"], install.dependencies);
  assert.deepEqual(install.lines, [
    "created owner/repo -> https://hooks.example.com/webhooks/github (hook 123)",
  ]);

  const status = fakeCli({ loadConfig: () => withUrl });
  await runCli(["webhooks", "status"], status.dependencies);
  assert.equal(status.lines.length, 13);
  assert.equal(
    status.lines[0],
    "owner/repo: hook 5 https://hooks.example.com/webhooks/github",
  );
  assert.equal(status.lines[1], "  2026-10-02T00:00:00Z issue_comment 202");
  assert.equal(status.lines[11], "owner/other:");
  assert.equal(status.lines[12], "  (no hook)");

  const funnel = { ...makeConfig(), tailscaleFunnel: true };
  const viaInstall = fakeCli({ loadConfig: () => funnel });
  await runWebhooksCommand(["install"], viaInstall.dependencies);
  assert.ok(viaInstall.calls.includes("funnelOn"));
  const viaStatus = fakeCli({ loadConfig: () => funnel });
  await runWebhooksCommand(["status"], viaStatus.dependencies);
  assert.ok(viaStatus.calls.includes("currentUrl"));
  assert.ok(!viaStatus.calls.includes("funnelOn"));

  const help = fakeCli();
  await runCli(["webhooks", "--help"], help.dependencies);
  assert.match(help.lines[0], /Usage:/);
  assert.match(help.lines.join("\n"), /webhooks install\|status/);
});

test("webhooks CLI rejects unknown commands and missing exposure config", async () => {
  await assert.rejects(
    runCli(["webhooks", "bogus"], fakeCli().dependencies),
    /Unknown webhooks command: bogus/,
  );
  await assert.rejects(
    runCli(["webhooks"], fakeCli().dependencies),
    /Unknown webhooks command: $/,
  );
  await assert.rejects(
    runCli(["webhooks", "install"], fakeCli().dependencies),
    /^Error: Set PUBLIC_URL or TAILSCALE_FUNNEL=true to use webhooks\.$/,
  );
});

test("daemon turns Funnel on before start and off on shutdown, tolerating teardown errors", async () => {
  const funnel = { ...makeConfig(), tailscaleFunnel: true };
  const fake = fakeCli({ loadConfig: () => funnel });
  await runCli([], fake.dependencies);
  assert.deepEqual(fake.calls.slice(0, 2), ["funnelOn", "started"]);
  fake.signals.get("SIGINT")?.();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(fake.calls.slice(-3), ["stopped", "funnelOff", "exit:0"]);

  for (const thrown of [new Error("down"), "down"]) {
    const failing = fakeCli({
      loadConfig: () => funnel,
      tailscale: {
        funnelOn: async () => "https://box.ts.net",
        funnelOff: async () => {
          throw thrown;
        },
        currentUrl: async () => "",
      },
    });
    await runCli([], failing.dependencies);
    failing.signals.get("SIGTERM")?.();
    await new Promise((done) => setImmediate(done));
    assert.ok(failing.calls.includes("exit:0"));
  }
});

test("Funnel is released when stop fails or when startup fails after funnelOn", async () => {
  const funnel = { ...makeConfig(), tailscaleFunnel: true };
  const stopFails = fakeCli({
    loadConfig: () => funnel,
    createDaemon: () => ({
      async start() {},
      async stop() {
        throw new Error("stop failed");
      },
      dispatchEvents() {},
      async idle() {},
    }),
  });
  await runCli([], stopFails.dependencies);
  stopFails.signals.get("SIGINT")?.();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(stopFails.calls.slice(-2), ["funnelOff", "exit:0"]);

  const startFails = fakeCli({
    loadConfig: () => funnel,
    tailscale: {
      async funnelOn() {
        throw new Error("status failed");
      },
      async funnelOff() {
        startFails.calls.push("funnelOff");
      },
      async currentUrl() {
        return "";
      },
    },
  });
  await assert.rejects(runCli([], startFails.dependencies), /status failed/);
  assert.deepEqual(startFails.calls, ["funnelOff"]);
});
