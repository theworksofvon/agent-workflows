import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { SerialQueue } from "../src/queue.js";
import { Store } from "../src/store.js";
import {
  GitHubClient,
  MARKER_TAG,
  type GitHubApi,
} from "../src/github/client.js";
import { Daemon } from "../src/daemon.js";
import type { AgentAdapter } from "../src/agents/types.js";
import { getAgent } from "../src/agents/registry.js";
import {
  getWorkflow,
  registerBuiltins,
  registerWorkflow,
} from "../src/workflows/registry.js";
import { createLogger } from "../src/log.js";
import {
  defaultCliDependencies,
  printHelp,
  printReviewResult,
  runCli,
  runEntryPoint,
  runReviewCommand,
  type CliDependencies,
} from "../src/index.js";
import type {
  PullRequestReviewRunResult,
  RunPullRequestReviewOptions,
} from "../src/workflows/pr-review/index.js";

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
    stateDir: join(root, "state"),
    zcodeBin: "zcode-test",
    claudeCodeBin: "claude-test",
    codexBin: "codex-test",
    keepWorkdirs: false,
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
      assert.equal(config.processExistingCommentsOnFirstRun, false);
      assert.equal(config.keepWorkdirs, false);
      assert.equal(config.stateDir, resolve("./state"));
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
        STATE_DIR: root,
        ZCODE_BIN: " z ",
        CLAUDE_CODE_BIN: " c ",
        CODEX_BIN: " x ",
        KEEP_WORKDIRS: "true",
      },
      () => {
        const config = loadConfig({ requireRepos: true });
        assert.equal(config.commentBatchMinComments, 3);
        assert.equal(config.commentBatchMaxWaitSec, 1.5);
        assert.equal(config.reviewAdversarialMode, "always");
        assert.equal(config.reviewAdversarialAgent, "claude-code");
        assert.equal(config.agentSelfUser, "bot");
        assert.equal(config.processExistingCommentsOnFirstRun, true);
        assert.equal(config.keepWorkdirs, true);
        assert.equal(config.zcodeBin, "z");
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
    [{ GITHUB_TOKEN: "x", REPOS: "" }, /REPOS must list/],
  ];
  for (const [env, expected] of cases) {
    withEnv(env, () => assert.throws(() => loadConfig(), expected));
  }
});

test("SerialQueue preserves order, exposes queued size, and recovers after rejection", async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  queue.enqueue(async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  queue.enqueue(async () => {
    order.push("second");
    throw new Error("expected failure");
  });
  queue.enqueue(async () => {
    order.push("third");
  });
  await new Promise((resolveNow) => setImmediate(resolveNow));
  assert.equal(queue.size, 2);
  release();
  for (
    let attempts = 0;
    attempts < 20 && order.at(-1) !== "third";
    attempts += 1
  ) {
    await new Promise((resolveNow) => setImmediate(resolveNow));
  }
  assert.deepEqual(order, ["first-start", "first-end", "second", "third"]);
  assert.equal(queue.size, 0);
  queue.enqueue(async () => {
    order.push("fourth");
  });
  await new Promise((resolveNow) => setImmediate(resolveNow));
  assert.equal(order.at(-1), "fourth");
});

test("Store persists values, reloads them, handles fallback/update, and resets malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-store-"));
  try {
    const store = new Store(root);
    assert.equal(store.get("missing", "fallback"), "fallback");
    store.set("count", 1);
    store.update<number>("count", (current) => (current ?? 0) + 1, 0);
    store.update<number>("reset", (() => undefined) as never, 7);
    const reloaded = new Store(root);
    assert.equal(reloaded.get("count", 0), 2);
    assert.equal(reloaded.get("reset", 0), 7);
    writeFileSync(join(root, "state.json"), "not-json");
    assert.equal(new Store(root).get("count", 9), 9);

    rmSync(join(root, "state.json"));
    mkdirSync(join(root, "state.json"));
    assert.throws(
      () => store.set("will-fail", true),
      /EISDIR|illegal operation|directory/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHubClient normalizes responses and sends exact Octokit arguments", async () => {
  const calls: Array<[string, unknown]> = [];
  const fake: GitHubApi = {
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
                head: { ref: "h2" },
                base: { ref: "b2" },
                draft: true,
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
              head: { ref: "feature" },
              base: { ref: "main" },
              draft: undefined,
            },
          };
        },
        listFiles: async () => ({ data: [] }),
        createReview: async (args: unknown) => {
          calls.push(["create-review", args]);
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
  const client = new GitHubClient("unused", { octokit: fake });
  const ref = { owner: "owner", repo: "repo" };
  assert.equal(MARKER_TAG, "<!-- agent-workflows:bot -->");
  assert.deepEqual(await client.listOpenPRs(ref), [
    {
      number: 1,
      title: "One",
      body: null,
      headRef: "head",
      baseRef: "base",
      draft: false,
    },
    {
      number: 2,
      title: "Two",
      body: "body",
      headRef: "h2",
      baseRef: "b2",
      draft: true,
    },
  ]);
  assert.equal((await client.listIssueComments(ref, 3)).length, 2);
  assert.deepEqual(
    await client.listIssueComments(ref, 3, Date.parse("2020-06-01")),
    [
      {
        id: 2,
        author: "author",
        body: "hello",
        createdAt: "2021-01-01T00:00:00Z",
      },
    ],
  );
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
  assert.equal(
    (await client.listReviewComments(ref, 3, Date.parse("2020-06-01")))[0]
      .reviewId,
    9,
  );
  await client.createComment(ref, 3, "body");
  assert.deepEqual(await client.getPullRequest(ref, 5), {
    number: 5,
    title: "PR",
    body: null,
    headRef: "feature",
    baseRef: "main",
    draft: false,
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
    ref,
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

test("agent and workflow registries route known entries and reject duplicates/unknown agents", () => {
  const config = makeConfig();
  assert.equal(getAgent("codex", config).name, "codex");
  assert.equal(getAgent("claude-code", config).name, "claude-code");
  assert.equal(getAgent("zcode", config).name, "zcode");
  assert.throws(() => getAgent("missing", config), /Unknown agent adapter/);
  const custom = { kind: "custom", async handle() {} };
  registerWorkflow(custom);
  assert.equal(getWorkflow("custom"), custom);
  assert.equal(getWorkflow("missing"), undefined);
  assert.throws(() => registerWorkflow(custom), /already registered/);
  registerBuiltins();
  assert.equal(getWorkflow("pr_comment")?.kind, "pr_comment");
});

test("Daemon dispatches serial work, reports missing workflows and poll errors, and posts comments", async () => {
  const config = makeConfig();
  const handled: string[] = [];
  const comments: unknown[] = [];
  let pollCount = 0;
  const daemon = new Daemon(
    config,
    {
      name: "fake-source",
      async poll() {
        pollCount += 1;
        return [
          { kind: "known", id: "1", payload: 1 },
          { kind: "missing", id: "2", payload: 2 },
          { kind: "known", id: "3", payload: 3 },
        ];
      },
    },
    {
      async createComment(...args: unknown[]) {
        comments.push(args);
      },
    },
    {
      name: "fake-agent",
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    {
      getWorkflow: (kind) =>
        kind === "known"
          ? {
              kind,
              async handle(event, ctx) {
                handled.push(String(event.payload));
                await ctx.postMarkerComment({
                  repo: { owner: "o", repo: "r" },
                  prNumber: 1,
                  body: "done",
                });
              },
            }
          : undefined,
    },
  );
  await daemon.tick();
  for (let attempts = 0; attempts < 20 && handled.length < 2; attempts += 1)
    await new Promise((done) => setImmediate(done));
  assert.deepEqual(handled, ["1", "3"]);
  assert.equal(comments.length, 2);
  assert.equal(pollCount, 1);

  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const agent: AgentAdapter = {
    name: "agent",
    async run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const client = { async createComment() {} };
  const overlapping = new Daemon(
    config,
    {
      name: "slow",
      async poll() {
        await gate;
        return [];
      },
    },
    client,
    agent,
  );
  const first = overlapping.tick();
  await overlapping.tick();
  release();
  await first;

  const failing = new Daemon(
    config,
    {
      name: "bad",
      async poll() {
        throw new Error("poll broke");
      },
    },
    client,
    agent,
  );
  await failing.tick();
});

test("Daemon start/stop owns one deterministic recursive timer", async () => {
  const config = makeConfig();
  const timers: Array<{ callback: () => void; delay: number; handle: object }> =
    [];
  const cleared: object[] = [];
  let polls = 0;
  const daemon = new Daemon(
    config,
    {
      name: "source",
      async poll() {
        polls += 1;
        return [];
      },
    },
    { async createComment() {} },
    {
      name: "agent",
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    {
      setTimeout: (callback, delay) => {
        const handle = setTimeout(() => {}, 60_000);
        handle.unref();
        const timer = { callback: () => callback(), delay, handle };
        timers.push(timer);
        return timer.handle;
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
        clearTimeout(handle);
      },
    },
  );
  await daemon.start();
  await daemon.start();
  assert.equal(polls, 1);
  assert.equal(timers[0].delay, 5000);
  timers[0].callback();
  await new Promise((done) => setImmediate(done));
  assert.equal(polls, 2);
  assert.equal(timers.length, 2);
  daemon.stop();
  assert.deepEqual(cleared, [timers[1].handle]);
  daemon.stop();

  const stopDuringPoll = new Daemon(
    config,
    {
      name: "source",
      async poll() {
        stopDuringPoll.stop();
        return [];
      },
    },
    { async createComment() {} },
    {
      name: "agent",
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    {
      setTimeout: () => {
        throw new Error("must not schedule");
      },
    },
  );
  await stopDuringPoll.start();
});

test("Daemon restart while the first start is polling keeps one timer chain", async () => {
  const config = makeConfig();
  const timers: Array<{
    callback: () => void;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  let polls = 0;
  let releaseFirstPoll!: () => void;
  const firstPollGate = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });
  const daemon = new Daemon(
    config,
    {
      name: "blocked-source",
      async poll() {
        polls += 1;
        if (polls === 1) await firstPollGate;
        return [];
      },
    },
    { async createComment() {} },
    {
      name: "agent",
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    {
      setTimeout: (callback) => {
        const handle = setTimeout(() => {}, 60_000);
        handle.unref();
        timers.push({ callback: () => callback(), handle });
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle),
    },
  );

  const firstStart = daemon.start();
  await new Promise((resolve) => setImmediate(resolve));
  daemon.stop();
  await daemon.start();
  assert.equal(timers.length, 1);

  releaseFirstPoll();
  await firstStart;
  assert.equal(timers.length, 1);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2);
  assert.equal(timers.length, 2);
  daemon.stop();
});

function reviewResult(
  overrides: Partial<PullRequestReviewRunResult> = {},
): PullRequestReviewRunResult {
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
    registerBuiltins: () => {
      calls.push("registered");
    },
    createPoller: () => ({
      name: "poller",
      async poll() {
        return [];
      },
    }),
    createDaemon: () => ({
      async start() {
        calls.push("started");
      },
      stop() {
        calls.push("stopped");
      },
    }),
    createReviewWorkflow: () => ({
      async run() {
        calls.push("reviewed");
        return reviewResult();
      },
    }),
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
  assert.deepEqual(daemon.calls.slice(0, 3), [
    "config:true",
    "registered",
    "started",
  ]);
  daemon.signals.get("SIGINT")?.();
  daemon.signals.get("SIGTERM")?.();
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

  const observed: RunPullRequestReviewOptions[] = [];
  const make = (mode: Config["reviewAdversarialMode"]) => {
    const config = makeConfig();
    config.reviewAdversarialMode = mode;
    return fakeCli({
      loadConfig: () => config,
      createReviewWorkflow: () => ({
        async run(options) {
          observed.push(options);
          return reviewResult();
        },
      }),
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

test("default CLI factories construct local runtime objects without external calls", () => {
  const config = makeConfig();
  const client = defaultCliDependencies.createClient("token");
  const agent = defaultCliDependencies.getAgent("codex", config);
  const source = defaultCliDependencies.createPoller({ config, client });
  const daemon = defaultCliDependencies.createDaemon({
    config,
    source,
    client,
    agent,
  });
  const workflow = defaultCliDependencies.createReviewWorkflow();
  assert.ok(client.octokit);
  assert.equal(agent.name, "codex");
  assert.equal(source.name, "github-pr-comments");
  assert.equal(typeof daemon.start, "function");
  assert.equal(typeof workflow.run, "function");
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
    (await import("../src/workflows/pr-review/types.js")).REVIEW_SEVERITIES,
    ["critical", "high", "medium", "low"],
  );
});
