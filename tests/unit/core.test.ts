import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  RETIRED_VARIABLES,
  type Config,
} from "../../src/config.js";
import {
  GitHubClient,
  type GitHubApi,
} from "../../src/adapters/github/octokit.js";
import { getAgent } from "../../src/adapters/agent/registry.js";
import { ghAccounts } from "../../src/adapters/github/accounts.js";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import {
  SESSIONS_KEPT_PER_PR,
  sqliteReviewSessions,
} from "../../src/adapters/state/review-sessions.js";
import { reviewApi, type ReviewApi } from "../../src/services/review-api.js";
import { createLogger } from "../../src/log.js";
import {
  defaultCliDependencies,
  printHelp,
  printReviewResult,
  runCli,
  runEntryPoint,
  runReviewCommand,
  runStartCommand,
  type CliDependencies,
} from "../../src/main.js";
import { sqliteSettings } from "../../src/adapters/state/settings.js";
import { githubAccess } from "../../src/services/github-access.js";
import { fakeAccounts, fakeClient } from "../fakes/github.js";
import type {
  ReviewRunResult,
  ReviewOptions,
} from "../../src/services/review-pr.js";

const CONFIG_KEYS = [
  "GITHUB_TOKEN",
  "AGENT",
  "REVIEW_ADVERSARIAL_MODE",
  "REVIEW_ADVERSARIAL_AGENT",
  "STATE_DIR",
  "CLAUDE_CODE_BIN",
  "CODEX_BIN",
  "KEEP_WORKDIRS",
  "MAX_CONCURRENT_RUNS",
  "UI_HOST",
  "UI_PORT",
  "UI_PUBLIC_PORT",
  ...RETIRED_VARIABLES,
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
    agent: "codex",
    reviewAdversarialMode: "auto",
    reviewAdversarialAgent: "claude-code",
    stateDir: join(root, "state"),
    claudeCodeBin: "claude-test",
    codexBin: "codex-test",
    keepWorkdirs: false,
    maxConcurrentRuns: 3,
    uiHost: "127.0.0.1",
    uiPort: 4773,
    uiPublicPort: 4773,
  };
}

test("loadConfig parses defaults and explicit values", () => {
  withEnv({ GITHUB_TOKEN: " token ", AGENT: " " }, () => {
    const config = loadConfig();
    assert.equal(config.githubToken, "token");
    assert.equal(config.agent, "codex");
    assert.equal(config.reviewAdversarialMode, "auto");
    assert.equal(config.reviewAdversarialAgent, "codex");
    assert.equal(config.keepWorkdirs, false);
    assert.equal(config.stateDir, resolve("./state"));
    assert.equal(config.claudeCodeBin, "claude");
    assert.equal(config.codexBin, "codex");
    assert.equal(config.maxConcurrentRuns, 3);
    assert.equal(config.uiHost, "127.0.0.1");
    assert.equal(config.uiPort, 4773);
    assert.equal(config.uiPublicPort, 4773);
  });

  const root = mkdtempSync(join(tmpdir(), "agent-workflows-config-"));
  try {
    withEnv(
      {
        GITHUB_TOKEN: "token",
        AGENT: "claude-code",
        REVIEW_ADVERSARIAL_MODE: "always",
        REVIEW_ADVERSARIAL_AGENT: "codex",
        STATE_DIR: root,
        CLAUDE_CODE_BIN: " c ",
        CODEX_BIN: " x ",
        KEEP_WORKDIRS: "true",
        MAX_CONCURRENT_RUNS: "1",
        UI_HOST: "0.0.0.0",
        UI_PORT: "9000",
        UI_PUBLIC_PORT: "4793",
      },
      () => {
        assert.deepEqual(loadConfig(), {
          githubToken: "token",
          agent: "claude-code",
          reviewAdversarialMode: "always",
          reviewAdversarialAgent: "codex",
          stateDir: root,
          claudeCodeBin: "c",
          codexBin: "x",
          keepWorkdirs: true,
          maxConcurrentRuns: 1,
          uiHost: "0.0.0.0",
          uiPort: 9000,
          uiPublicPort: 4793,
        });
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects the removed ZCode agent", () => {
  const base = { GITHUB_TOKEN: "x" };
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ ...base, AGENT: "zcode" }, /AGENT=zcode: ZCode support was removed/],
    [
      { ...base, REVIEW_ADVERSARIAL_AGENT: "zcode" },
      /REVIEW_ADVERSARIAL_AGENT=zcode: ZCode support was removed/,
    ],
  ];
  for (const [env, message] of cases)
    withEnv(env, () => assert.throws(() => loadConfig(), message));
});

test("loadConfig warns about retired variables that are still set, without failing", () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    const base = { GITHUB_TOKEN: "x" };
    withEnv(base, () => loadConfig());
    assert.deepEqual(warnings, []);
    // Values the feedback bot would have rejected no longer matter.
    withEnv(
      {
        ...base,
        ZCODE_BIN: "zcode",
        REPOS: "not-a-slug",
        PORT: "4773",
        TAILSCALE_FUNNEL: "true",
        DECISION_ENGINE: "magic",
        DECISION_TIMEOUT_MS: "1",
      },
      () => loadConfig(),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no longer read/);
    assert.match(warnings[0], /"REPOS","PORT","TAILSCALE_FUNNEL","ZCODE_BIN"/);
  } finally {
    console.warn = original;
  }
});

test("loadConfig leaves GITHUB_TOKEN unset when it is missing or blank, for gh's accounts", () => {
  for (const env of [{}, { GITHUB_TOKEN: "   " }]) {
    withEnv(env, () => assert.equal(loadConfig().githubToken, undefined));
  }
});

test("loadConfig rejects every invalid enum and numeric value", () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ GITHUB_TOKEN: "x", REVIEW_ADVERSARIAL_MODE: "sometimes" }, /one of/],
    [{ GITHUB_TOKEN: "x", MAX_CONCURRENT_RUNS: "1.5" }, /MAX_CONCURRENT_RUNS/],
    [{ GITHUB_TOKEN: "x", MAX_CONCURRENT_RUNS: "0" }, /MAX_CONCURRENT_RUNS/],
    [{ GITHUB_TOKEN: "x", MAX_CONCURRENT_RUNS: "NaN" }, /MAX_CONCURRENT_RUNS/],
    [{ GITHUB_TOKEN: "x", UI_PORT: "0" }, /UI_PORT must be an integer/],
    [{ GITHUB_TOKEN: "x", UI_PORT: "80.5" }, /UI_PORT/],
    [{ GITHUB_TOKEN: "x", UI_PORT: "70000" }, /between 1 and 65535/],
    [{ UI_PUBLIC_PORT: "0" }, /UI_PUBLIC_PORT must be an integer between/],
  ];
  for (const [env, expected] of cases) {
    withEnv(env, () => assert.throws(() => loadConfig(), expected));
  }
});

function fakeGitHub(calls: Array<[string, unknown]>): GitHubApi {
  return {
    graphql: async () => {
      throw new Error("graphql is not faked here");
    },
    rest: {
      users: {
        getAuthenticated: async () => ({
          data: { login: "me", avatar_url: null },
        }),
      },
      pulls: {
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
  assert.deepEqual(await client.getPullRequest(ref, 5), {
    repo: ref,
    number: 5,
    title: "PR",
    body: null,
    headRef: "feature",
    baseRef: "main",
    draft: false,
  });
  assert.deepEqual(calls.find(([name]) => name === "get")?.[1], {
    owner: "owner",
    repo: "repo",
    pull_number: 5,
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
  await client.createPullRequestReview({
    repo: ref,
    prNumber: 5,
    body: "approved",
    comments: [],
    event: "APPROVE",
    commitId: "abc123",
  });
  const approval = calls.filter(
    ([name]) => name === "create-review",
  )[1]?.[1] as {
    event: string;
    commit_id: string;
  };
  assert.equal(approval.event, "APPROVE");
  assert.equal(approval.commit_id, "abc123");
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

test("agent registry routes known entries and rejects unknown agents", () => {
  const config = makeConfig();
  assert.equal(getAgent("codex", config).name, "codex");
  assert.equal(getAgent("claude-code", config).name, "claude-code");
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
    loadConfig: () => {
      calls.push("config");
      return config;
    },
    createClient: () => ({}) as GitHubClient,
    accounts: () => fakeAccounts(["alice"]),
    getAgent: (name) => ({
      name,
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    reviewPullRequest: async () => {
      calls.push("reviewed");
      return reviewResult();
    },
    startReviewServer: async (args) => ({
      url: `http://${args.host}:${args.port}`,
      close: async () => {
        calls.push("server-closed");
      },
    }),
    every: () => () => {
      calls.push("prune-stopped");
    },
    shutdownGraceMs: 1_000,
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

test("CLI help, start routing, signal lifecycle, and entrypoint fatal handling are deterministic", async () => {
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
  // `start` is the default command and `ui` is its old name.
  for (const [args, first, second] of [
    [[], "SIGINT", "SIGTERM"],
    [["start"], "SIGTERM", "SIGINT"],
    [["ui"], "SIGINT", "SIGTERM"],
  ] as const) {
    const app = fakeCli();
    await runCli([...args], app.dependencies);
    assert.deepEqual(app.calls, ["config"]);
    assert.deepEqual(app.lines, ["Guided review: http://127.0.0.1:4773"]);
    app.signals.get(first)?.();
    await new Promise((done) => setImmediate(done));
    // A second signal during shutdown does not start a second shutdown.
    app.signals.get(second)?.();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(app.calls.slice(1), [
      "prune-stopped",
      "server-closed",
      "exit:0",
    ]);
  }
  await assert.rejects(
    runCli(["webhooks", "install"], fakeCli().dependencies),
    /^Error: Unknown command: webhooks$/,
  );
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

  assert.deepEqual(
    observed.map((item) => item.token),
    ["test-token", "test-token", "test-token"],
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

test("review without GITHUB_TOKEN clones and reads the PR as gh's active account", async () => {
  const config = { ...makeConfig(), githubToken: undefined };
  const clients: string[] = [];
  const observed: ReviewOptions[] = [];
  const fake = fakeCli({
    loadConfig: () => config,
    accounts: () => fakeAccounts(["von", "alice"]),
    createClient: (token) => {
      clients.push(token);
      return {} as GitHubClient;
    },
    reviewPullRequest: async (options) => {
      observed.push(options);
      return reviewResult();
    },
  });
  await runReviewCommand(["owner/repo#7"], fake.dependencies);
  assert.deepEqual(clients, ["token:von"]);
  assert.equal(observed[0].token, "token:von");

  const noAccount = fakeCli({
    loadConfig: () => config,
    accounts: (_, lookupUser) =>
      ghAccounts({
        fallbackToken: undefined,
        exec: async () => "[]",
        lookupUser,
      }),
  });
  await assert.rejects(
    runReviewCommand(["owner/repo#7"], noAccount.dependencies),
    /GITHUB_TOKEN is not set; run gh auth login/,
  );
});

test("default CLI factories construct local runtime objects without external calls", async () => {
  const config = makeConfig();
  const client = defaultCliDependencies.createClient("token");
  const agent = defaultCliDependencies.getAgent("codex", config);
  const accounts = defaultCliDependencies.accounts(config, async () => ({
    login: "unused",
    avatarUrl: null,
  }));
  assert.equal(typeof accounts.token, "function");
  assert.ok(client.octokit);
  assert.equal(agent.name, "codex");
  assert.equal(typeof defaultCliDependencies.reviewPullRequest, "function");
  assert.equal(defaultCliDependencies.shutdownGraceMs, 15_000);
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

function uiCli(
  root: string,
  overrides: Partial<Config> = {},
  close: () => Promise<void> = async () => {},
) {
  const config = { ...makeConfig(root), ...overrides };
  const servers: Array<{
    host: string;
    port: number;
    publicPort: number;
    api: ReviewApi;
  }> = [];
  const fake = fakeCli({
    loadConfig: () => {
      fake.calls.push("config");
      return config;
    },
    startReviewServer: async (args) => {
      servers.push(args);
      return {
        url: `http://${args.host}:${args.port}`,
        close: async () => {
          fake.calls.push("server-closed");
          await close();
        },
      };
    },
  });
  return { ...fake, servers, config };
}

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("start prints help and rejects unknown options", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const fake = uiCli(tmpdir());
    await runCli(["start", flag], fake.dependencies);
    assert.match(fake.lines.join("\n"), /start +Serve the guided review app/);
    assert.deepEqual(fake.servers, []);
  }
  await assert.rejects(
    runCli(["ui", "--port"], uiCli(tmpdir()).dependencies),
    /Unknown start option: --port/,
  );
  await assert.rejects(
    runStartCommand(["--port"], uiCli(tmpdir()).dependencies),
    /Unknown start option: --port/,
  );
});

test("start fails interrupted sessions, serves the API, runs reviews in the background, and shuts down", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-"));
  try {
    const seed = openStateDatabase(join(root, "state"));
    const stuck = sqliteReviewSessions(seed).create({
      repo: { owner: "acme", repo: "widgets" },
      prNumber: 1,
      agent: "codex",
      account: "alice",
    });
    seed.close();

    const fake = uiCli(root);
    await runCli(["start"], fake.dependencies);
    assert.ok(fake.calls.includes("config"));
    assert.deepEqual(fake.lines, ["Guided review: http://127.0.0.1:4773"]);
    assert.equal(fake.servers.length, 1);
    const { api, host, port } = fake.servers[0];
    assert.equal(host, "127.0.0.1");
    assert.equal(port, 4773);
    assert.deepEqual(api.health(), { ok: true, agent: "codex" });
    const interrupted = api.getSession(stuck.id).session;
    assert.equal(interrupted.status, "failed");
    assert.match(String(interrupted.error), /interrupted/);

    // The fake GitHub client has no methods, so the background run fails
    // and records that on the session instead of throwing.
    const { id } = await api.createSession({ target: "acme/widgets#2" });
    await settle(() => api.getSession(id).session.status === "failed");
    assert.equal(api.getSession(id).session.status, "failed");

    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
    assert.deepEqual(fake.calls.slice(-2), ["server-closed", "exit:0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start queues runs past the concurrency cap and warns about a non-loopback host", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-queue-"));
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  const fetches: Array<() => void> = [];
  try {
    const fake = uiCli(root, { maxConcurrentRuns: 1, uiHost: "0.0.0.0" });
    fake.dependencies.createClient = () =>
      ({
        getPullRequestDetail: () =>
          new Promise((_resolve, reject) => {
            fetches.push(() => reject(new Error("offline")));
          }),
        listPullRequestFiles: async () => [],
      }) as unknown as GitHubClient;
    await runCli(["start"], fake.dependencies);
    assert.ok(
      warnings.some((line) => /UI_HOST is not a loopback address/.test(line)),
    );
    const { api } = fake.servers[0];

    const first = (await api.createSession({ target: "acme/widgets#1" })).id;
    const second = (await api.createSession({ target: "acme/widgets#2" })).id;
    await settle(() => fetches.length === 1);
    assert.equal(api.getSession(first).session.status, "triaging");
    assert.equal(api.getSession(second).session.status, "queued");

    fetches[0]();
    await settle(() => fetches.length === 2);
    assert.equal(api.getSession(first).session.status, "failed");
    assert.equal(api.getSession(second).session.status, "triaging");
    fetches[1]();
    await settle(() => api.getSession(second).session.status === "failed");

    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    console.warn = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("start passes the public port and exits even if the server close fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-s1-"));
  const original = console.error;
  const errors: string[] = [];
  console.error = (line: string) => {
    errors.push(line);
  };
  try {
    const fake = uiCli(root, { uiPort: 4799, uiPublicPort: 4800 }, async () => {
      throw new Error("close failed");
    });
    await runCli(["start"], fake.dependencies);
    assert.deepEqual(fake.lines, ["Guided review: http://127.0.0.1:4799"]);
    assert.equal(fake.servers[0].publicPort, 4800);
    fake.signals.get("SIGINT")?.();
    await settle(() => fake.calls.includes("exit:0"));
    assert.ok(fake.calls.includes("exit:0"));
    assert.ok(errors.some((line) => /review server close failed/.test(line)));
  } finally {
    console.error = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("start records the current account on sessions stored without one, looking avatars up as that token", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-adopt-"));
  const original = console.log;
  const infos: string[] = [];
  console.log = (line: string) => {
    infos.push(line);
  };
  try {
    const seed = openStateDatabase(join(root, "state"));
    const store = sqliteReviewSessions(seed);
    const { id } = store.create({
      repo: { owner: "acme", repo: "widgets" },
      prNumber: 1,
      agent: "codex",
      account: "",
    });
    seed
      .prepare(
        "UPDATE review_sessions SET payload = json_remove(payload, '$.account')",
      )
      .run();
    seed.close();

    const viewers: string[] = [];
    const fake = uiCli(root);
    fake.dependencies.createClient = (token) =>
      ({
        viewer: async () => {
          viewers.push(token);
          return { login: "alice", avatarUrl: null };
        },
      }) as unknown as GitHubClient;
    fake.dependencies.accounts = (_config, lookupUser) => {
      const accounts = fakeAccounts(["alice"]);
      return {
        ...accounts,
        active: async () => (await lookupUser("token:alice")).login,
      };
    };
    await runCli(["start"], fake.dependencies);
    const { api } = fake.servers[0];
    await settle(() => api.getSession(id).session.account === "alice");
    assert.equal(api.getSession(id).session.account, "alice");
    assert.ok(viewers.includes("token:alice"));
    assert.ok(
      infos.some((l) => /recorded the account on older guided reviews/.test(l)),
    );
    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    console.log = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("start still serves when no GitHub account resolves", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-noaccount-"));
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    const fake = uiCli(root);
    fake.dependencies.accounts = () => ({
      ...fakeAccounts(),
      active: async () => {
        throw new Error("gh and GITHUB_TOKEN both failed");
      },
    });
    await runCli(["start"], fake.dependencies);
    await settle(() =>
      warnings.some((l) =>
        /could not resolve the current GitHub account/.test(l),
      ),
    );
    assert.ok(warnings.some((l) => /both failed/.test(l)));
    assert.equal(fake.servers.length, 1);
    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    console.warn = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("start prunes old sessions at start and daily, and runs reviews on the run cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "start-ui-"));
  try {
    const config = { ...makeConfig(root), maxConcurrentRuns: 1 };
    const seed = openStateDatabase(config.stateDir);
    const seeded = sqliteReviewSessions(seed);
    for (let i = 0; i < SESSIONS_KEPT_PER_PR + 2; i++) {
      const { id } = seeded.create({
        repo: { owner: "owner", repo: "repo" },
        prNumber: 1,
        agent: "codex",
        account: "alice",
      });
      seeded.update(id, { status: "ready" });
    }
    seed.close();

    const schedules: Array<[number, () => void]> = [];
    const fake = fakeCli({
      loadConfig: () => config,
      startReviewServer: async (args) => {
        fake.calls.push(`ui:${args.host}:${args.port}`);
        servers.push(args.api);
        return { url: "http://ui", close: async () => {} };
      },
      every: (ms, fn) => {
        schedules.push([ms, fn]);
        return () => {};
      },
    });
    const servers: ReviewApi[] = [];
    await runCli([], fake.dependencies);
    assert.ok(fake.calls.includes("ui:127.0.0.1:4773"));
    const [api] = servers;
    assert.equal(api.listSessions().sessions.length, SESSIONS_KEPT_PER_PR);
    assert.equal(schedules[0][0], 24 * 60 * 60 * 1000);
    schedules[0][1]();
    assert.equal(api.listSessions().sessions.length, SESSIONS_KEPT_PER_PR);

    // The fake client has no methods, so the run fails fast.
    const { id } = await api.createSession({ target: "owner/repo#2" });
    await settle(() => api.getSession(id).session.status === "failed");
    assert.equal(api.getSession(id).session.status, "failed");

    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default scheduler repeats until stopped", async () => {
  let ticks = 0;
  const stop = defaultCliDependencies.every(1, () => {
    ticks += 1;
  });
  await settle(() => ticks >= 2);
  stop();
  const seen = ticks;
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(ticks, seen);
});

test("the default review server dependency serves on the given address", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-default-"));
  const db = openStateDatabase(join(root, "state"));
  try {
    const handle = await defaultCliDependencies.startReviewServer({
      host: "127.0.0.1",
      port: 0,
      publicPort: 0,
      api: reviewApi({
        sessions: sqliteReviewSessions(db),
        github: githubAccess({
          accounts: fakeAccounts(),
          settings: sqliteSettings(db),
          createClient: (token) => fakeClient(token, []),
        }),
        startRun: async () => {},
        agent: "codex",
      }),
    });
    try {
      const res = await fetch(`${handle.url}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Captures what `fn` logs at each level. */
async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ["log", "warn", "error"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods)
    console[m] = (line: string) => {
      lines.push(line);
    };
  try {
    return { result: await fn(), lines };
  } finally {
    methods.forEach((m, i) => (console[m] = originals[i]));
  }
}

const walFile = (stateDir: string) =>
  join(stateDir, "agent-workflows.sqlite-wal");

test("start fails and closes the database when the app cannot bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-fail-"));
  try {
    const fake = uiCli(root);
    fake.dependencies.startReviewServer = async () => {
      throw new Error("listen EADDRINUSE 127.0.0.1:4773");
    };
    await assert.rejects(runCli(["start"], fake.dependencies), /EADDRINUSE/);
    assert.deepEqual(fake.lines, []);
    assert.ok(existsSync(join(fake.config.stateDir, "agent-workflows.sqlite")));
    assert.equal(existsSync(walFile(fake.config.stateDir)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo cache that cannot be read is a warning, not a startup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-scrub-"));
  try {
    const fake = uiCli(root);
    mkdirSync(fake.config.stateDir, { recursive: true });
    writeFileSync(join(fake.config.stateDir, "repos"), "not a directory");
    const { lines } = await captureLogs(() =>
      runCli(["start"], fake.dependencies),
    );
    assert.ok(
      lines.some((l) =>
        /could not check the repo caches for stored credentials/.test(l),
      ),
    );
    assert.equal(fake.servers.length, 1);
    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GITHUB_TOKEN's stand-in account is never recorded on older sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ui-cli-fallback-"));
  try {
    const seed = openStateDatabase(join(root, "state"));
    const { id } = sqliteReviewSessions(seed).create({
      repo: { owner: "acme", repo: "widgets" },
      prNumber: 1,
      agent: "codex",
      account: "",
    });
    seed.close();

    const fake = uiCli(root);
    fake.dependencies.accounts = () => ({
      ...fakeAccounts(["daemon-bot"]),
      isFallback: async () => true,
    });
    const { lines } = await captureLogs(async () => {
      await runCli(["start"], fake.dependencies);
      await settle(() => fake.lines.length > 0);
      await new Promise((done) => setTimeout(done, 10));
    });
    assert.ok(lines.some((l) => /not recording an account/.test(l)));
    const { api } = fake.servers[0];
    assert.equal(api.getSession(id).session.account, "");
    fake.signals.get("SIGTERM")?.();
    await settle(() => fake.calls.includes("exit:0"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start shuts down in order: the app, its publishes, the runs, then the database", async () => {
  const root = mkdtempSync(join(tmpdir(), "start-order-"));
  try {
    const config = makeConfig(root);
    const seed = openStateDatabase(config.stateDir);
    const seeded = sqliteReviewSessions(seed);
    const ready = seeded.create({
      repo: { owner: "acme", repo: "widgets" },
      prNumber: 7,
      agent: "codex",
      account: "alice",
    });
    seeded.update(ready.id, {
      status: "ready",
      pr: {
        title: "t",
        body: null,
        author: "octocat",
        authorAvatarUrl: null,
        state: "open",
        lastCommit: null,
        url: "https://github.com/acme/widgets/pull/7",
        headRef: "feat",
        baseRef: "main",
        headSha: "abc123",
        files: [],
      },
    });
    seed.close();

    let postReview!: () => void;
    let failFetch!: () => void;
    let api!: ReviewApi;
    const fake = fakeCli({
      loadConfig: () => config,
      // The guided run below outlives the grace.
      shutdownGraceMs: 20,
      createClient: () =>
        ({
          createPullRequestReview: () =>
            new Promise<void>((done) => {
              postReview = () => {
                fake.calls.push("review-posted");
                done();
              };
            }),
          getPullRequestDetail: () =>
            new Promise((_resolve, reject) => {
              failFetch = () => reject(new Error("offline"));
            }),
          listPullRequestFiles: async () => [],
        }) as unknown as GitHubClient,
      startReviewServer: async (args) => {
        api = args.api;
        return {
          url: "http://ui",
          close: async () => {
            fake.calls.push("server-closed");
          },
        };
      },
    });
    const { lines } = await captureLogs(async () => {
      await runCli([], fake.dependencies);
      // A guided run waits on GitHub, and a publish waits on GitHub too.
      const { id: running } = await api.createSession({
        target: "acme/widgets#8",
      });
      await settle(() => failFetch !== undefined);
      const publish = api.publish(ready.id, {
        event: "COMMENT",
        confirm: true,
      });
      await settle(() => postReview !== undefined);

      fake.signals.get("SIGTERM")?.();
      await settle(() => fake.calls.includes("server-closed"));
      await new Promise((done) => setTimeout(done, 10));
      // The app does not exit before the publish finishes.
      assert.ok(!fake.calls.includes("exit:0"));
      postReview();
      await publish;
      await settle(() => fake.calls.includes("exit:0"));
      assert.deepEqual(fake.calls.slice(-4), [
        "prune-stopped",
        "server-closed",
        "review-posted",
        "exit:0",
      ]);
      // The run outlived the drain; when it resumes it must not write.
      failFetch();
      await new Promise((done) => setTimeout(done, 10));
      return running;
    });
    assert.ok(lines.some((l) => /guided review stopped by shutdown/.test(l)));
    assert.ok(!lines.some((l) => /could not record/.test(l)));

    const after = openStateDatabase(config.stateDir);
    const store = sqliteReviewSessions(after);
    assert.notEqual(store.get(ready.id)?.publishedAt, null);
    const interrupted = store.list(10).find((s) => s.prNumber === 8)!;
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.stage, "Interrupted");
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
