import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import type { Config, ReviewAdversarialMode } from "./config.js";
import { GitHubClient } from "./adapters/github/octokit.js";
import {
  ghAccounts,
  type GitHubAccountsPort,
} from "./adapters/github/accounts.js";
import { sqliteSettings } from "./adapters/state/settings.js";
import { githubAccess } from "./services/github-access.js";
import type { Account } from "./domain/inbox.js";
import { openStateDatabase, sqliteState } from "./adapters/state/sqlite.js";
import {
  sqliteReviewSessions,
  type ReviewSessionStore,
} from "./adapters/state/review-sessions.js";
import { startReviewServer } from "./adapters/http/review-server.js";
import type { ServerHandle } from "./adapters/http/http-util.js";
import {
  GUIDED_RUN_SLOTS,
  runGuidedReview,
  type GuidedReviewDeps,
} from "./services/guided-review.js";
import { reviewApi, type ReviewApi } from "./services/review-api.js";
import { reviewEvents } from "./services/review-events.js";
import { t3Link } from "./services/t3-link.js";
import { sqliteT3Threads } from "./adapters/state/t3-threads.js";
import { connectT3 } from "./adapters/t3/t3-client.js";
import { gitExec, scrubRepoCacheCredentials } from "./adapters/git/exec.js";
import { getAgent } from "./adapters/agent/registry.js";
import type { AgentAdapter } from "./adapters/agent/agent.interface.js";
import { Dispatcher } from "./services/dispatch.js";
import { log } from "./log.js";
import { parseReviewTarget } from "./domain/target.js";
import { reviewPullRequest } from "./services/review-pr.js";
import type { ReviewRunResult } from "./services/review-pr.js";
import { errorMessage } from "./domain/util.js";
import { ServerStoppedError } from "./domain/errors.js";

export interface CliDependencies {
  loadConfig(): Config;
  createClient(token: string, apiUrl: string): GitHubClient;
  /**
   * The GitHub accounts the guided review app can act as; `lookupUser` is
   * GET /user with a token.
   */
  accounts(
    config: Config,
    lookupUser: (token: string) => Promise<Account>,
  ): GitHubAccountsPort;
  getAgent(name: string, config: Config): AgentAdapter;
  reviewPullRequest: typeof reviewPullRequest;
  startReviewServer(args: {
    host: string;
    port: number;
    publicPort: number;
    api: ReviewApi;
  }): Promise<ServerHandle>;
  /** Calls `fn` every `ms` without keeping the process alive; returns a stop. */
  every(ms: number, fn: () => void): () => void;
  /**
   * How long shutdown waits for running guided runs. Runs still going after
   * it are marked failed.
   */
  shutdownGraceMs: number;
  onSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code: number): void;
  writeLine(line: string): void;
}

export const defaultCliDependencies: CliDependencies = {
  loadConfig,
  createClient: (token, apiUrl) => new GitHubClient(token, { baseUrl: apiUrl }),
  accounts: (config, lookupUser) =>
    ghAccounts({ fallbackToken: config.githubToken, lookupUser }),
  getAgent,
  reviewPullRequest,
  startReviewServer,
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
  shutdownGraceMs: 15_000,
  onSignal: process.on.bind(process),
  exit: process.exit.bind(process),
  writeLine: console.log,
};

function adversarialAgentFor(
  mode: ReviewAdversarialMode,
  config: Config,
  resolve: CliDependencies["getAgent"],
): AgentAdapter | undefined {
  return mode === "off"
    ? undefined
    : resolve(config.reviewAdversarialAgent, config);
}

const HELP_FLAGS = ["--help", "-h", "help"];

export async function runCli(
  args: string[],
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
  const [command, ...rest] = args;
  if (command !== undefined && HELP_FLAGS.includes(command)) {
    printHelp(dependencies.writeLine);
    return;
  }
  if (command === "review") {
    if (rest[0] !== undefined && HELP_FLAGS.includes(rest[0])) {
      printHelp(dependencies.writeLine);
      return;
    }
    await runReviewCommand(rest, dependencies);
    return;
  }
  if (command === "open") return runOpenCommand(rest, dependencies);
  if (command === undefined) return runStartCommand([], dependencies);
  // `ui` is the name earlier versions used for `start`.
  if (command === "start" || command === "ui")
    return runStartCommand(rest, dependencies);
  throw new Error(`Unknown command: ${command}`);
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Daily, so a long-running app still drops old guided review sessions. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Serves the guided review app and API, and runs each requested review in
 * the background until SIGINT or SIGTERM.
 */
export async function runStartCommand(
  args: string[],
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
  const [option] = args;
  if (option !== undefined && HELP_FLAGS.includes(option)) {
    printHelp(dependencies.writeLine);
    return;
  }
  if (option !== undefined) throw new Error(`Unknown start option: ${option}`);

  const config = dependencies.loadConfig();
  scrubCredentials(config);
  const db = openStateDatabase(config.stateDir);
  const runs = new Dispatcher(config.maxConcurrentRuns);
  let ui: GuidedReviewService;
  try {
    ui = await startGuidedReview(config, db, runs, dependencies);
  } catch (err) {
    db.close();
    throw err;
  }
  // The app stops taking requests and finishes its publishes, the runs get
  // the shutdown grace to finish, and the runs that outlive it are marked
  // failed and stop writing before the database closes.
  let stopping = false;
  const stop = async (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    await closeUi(ui);
    await runs.drain(dependencies.shutdownGraceMs);
    ui.release();
    db.close();
    dependencies.exit(0);
  };
  dependencies.onSignal("SIGINT", () => void stop("SIGINT"));
  dependencies.onSignal("SIGTERM", () => void stop("SIGTERM"));
  // Printed last: the address tells a caller that a signal now shuts down cleanly.
  dependencies.writeLine(`Guided review: ${ui.url}`);
}

/** Removes tokens that older versions stored in the repo caches' remote URLs. */
function scrubCredentials(config: Config): void {
  try {
    scrubRepoCacheCredentials(config.stateDir);
  } catch (err) {
    log.warn("could not check the repo caches for stored credentials", {
      error: errorMessage(err),
    });
  }
}

interface GuidedReviewService {
  url: string;
  /** Stops taking requests and waits for every publish in flight. */
  close(): Promise<void>;
  /**
   * Fails the guided runs that are still going and stops their writes, so
   * the database can close.
   */
  release(): void;
}

/**
 * Fails sessions a previous process left running, prunes old sessions now
 * and once a day, records the current account on sessions stored without
 * one, and serves the guided review app on UI_HOST:UI_PORT. Runs past
 * MAX_CONCURRENT_RUNS wait on `runs` with status "queued".
 */
async function startGuidedReview(
  config: Config,
  db: DatabaseSync,
  runs: Dispatcher,
  dependencies: CliDependencies,
): Promise<GuidedReviewService> {
  if (!LOOPBACK_HOSTS.includes(config.uiHost))
    log.warn(
      "UI_HOST is not a loopback address: the guided review app has no login, so anyone who can reach it can publish reviews as you",
      { uiHost: config.uiHost },
    );
  const sessions = sqliteReviewSessions(db);
  failInterrupted(sessions);
  let released = false;
  const prune = () => {
    const pruned = sessions.prune();
    if (pruned > 0) log.info("pruned old guided reviews", { count: pruned });
  };
  prune();
  const accounts = ghAccountsOf(config, dependencies);
  const github = githubAccess({
    accounts,
    settings: sqliteSettings(db),
    createClient: (token) =>
      dependencies.createClient(token, config.githubApiUrl),
  });
  void adoptAccount(sessions, github, accounts);
  // A deep triage runs the adversarial pass even when the mode is "off".
  const deps: GuidedReviewDeps = {
    config,
    github,
    git: gitExec,
    sessions: untilReleased(sessions, () => released),
    agent: dependencies.getAgent(config.agent, config),
    adversarialAgent: dependencies.getAgent(
      config.reviewAdversarialAgent,
      config,
    ),
  };
  const api = reviewApi({
    sessions,
    github,
    startRun: async (id) => {
      runs.enqueue(
        `guide:${id}`,
        () => runGuidedReview(id, deps),
        GUIDED_RUN_SLOTS,
      );
    },
    agent: config.agent,
    events: reviewEvents(),
    t3: t3Link({
      settings: sqliteSettings(db),
      threads: sqliteT3Threads(db),
      defaultMcpUrl: config.t3McpUrl,
      appUrl: `http://127.0.0.1:${config.uiPublicPort}`,
      connect: connectT3,
    }),
  });
  const server = await dependencies.startReviewServer({
    host: config.uiHost,
    port: config.uiPort,
    publicPort: config.uiPublicPort,
    api,
  });
  const stopPruning = dependencies.every(PRUNE_INTERVAL_MS, prune);
  return {
    url: server.url,
    close: async () => {
      stopPruning();
      try {
        await server.close();
      } finally {
        await api.settled();
      }
    },
    release: () => {
      released = true;
      failInterrupted(sessions);
    },
  };
}

function failInterrupted(sessions: ReviewSessionStore): void {
  const interrupted = sessions.failInterrupted();
  if (interrupted > 0)
    log.warn("marked interrupted guided reviews as failed", {
      count: interrupted,
    });
}

/** A guided run's reads and writes throw ServerStoppedError after release. */
function untilReleased(
  store: ReviewSessionStore,
  released: () => boolean,
): ReviewSessionStore {
  const open = () => {
    if (released()) throw new ServerStoppedError();
  };
  return {
    ...store,
    get: (id) => {
      open();
      return store.get(id);
    },
    update: (id, patch) => {
      open();
      return store.update(id, patch);
    },
  };
}

/**
 * Records gh's current account on sessions stored without one. GITHUB_TOKEN's
 * account is only a stand-in, so it is never recorded.
 */
async function adoptAccount(
  sessions: ReviewSessionStore,
  github: ReturnType<typeof githubAccess>,
  accounts: GitHubAccountsPort,
): Promise<void> {
  try {
    if (await accounts.isFallback()) {
      log.info(
        "not recording an account on older guided reviews: gh has no account",
      );
      return;
    }
    const login = await github.current();
    const adopted = sessions.adoptAccount(login);
    if (adopted > 0)
      log.info("recorded the account on older guided reviews", {
        count: adopted,
        account: login,
      });
  } catch (err) {
    log.warn("could not resolve the current GitHub account", {
      error: errorMessage(err),
    });
  }
}

async function closeUi(ui: GuidedReviewService): Promise<void> {
  try {
    await ui.close();
  } catch (err) {
    log.error("review server close failed", { error: errorMessage(err) });
  }
}

export function printHelp(
  writeLine: (line: string) => void = console.log,
): void {
  writeLine(`agent-workflows

Usage:
  pnpm start
  pnpm review owner/repo#123 [--post|--dry-run] [--adversarial|--no-adversarial]
  pnpm agent-workflows open owner/repo#123

Commands:
  start    Serve the guided review app and API on UI_HOST:UI_PORT (default 127.0.0.1:4773).
           This is the default command; ui is an alias.
  open     Start a guided review of a PR in the running app and open it in its T3 thread
  review   Run a read-only pull-request review; add --post to publish findings
  help     Show this message`);
}

/** How long `open` waits for the agents to finish a guided review. */
const OPEN_WAIT_MS = 15 * 60 * 1000;
const OPEN_POLL_MS = 1000;

/**
 * Asks the running app to review a PR, waits for the run, and opens the
 * review in its T3 thread. It starts no server: `start` must be running.
 */
export async function runOpenCommand(
  args: string[],
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
  const [target, ...extra] = args;
  if (!target || extra.length > 0 || target.startsWith("-"))
    throw new Error("Usage: pnpm agent-workflows open owner/repo#123");
  const config = dependencies.loadConfig();
  const base = `http://127.0.0.1:${config.uiPublicPort}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(`${base}/${path}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(
        `The review app is not running at ${base}. Start it with mise run start.`,
      );
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? res.status));
    return data;
  };
  const { id } = (await call("POST", "sessions", { target })) as { id: string };
  dependencies.writeLine(`Review started: ${id}`);
  const deadline = Date.now() + OPEN_WAIT_MS;
  for (;;) {
    const { session } = (await call("GET", `sessions/${id}`)) as {
      session: { status: string; error: string | null };
    };
    if (session.status === "failed")
      throw new Error(`The review failed: ${session.error}`);
    if (session.status === "ready") break;
    if (Date.now() > deadline)
      throw new Error(`The review is still running: ${id}`);
    await new Promise((done) => setTimeout(done, OPEN_POLL_MS));
  }
  const { thread } = (await call("POST", `sessions/${id}/t3`)) as {
    thread: { title: string; url: string | null };
  };
  dependencies.writeLine(`Opened in T3: ${thread.title}`);
  if (thread.url) dependencies.writeLine(thread.url);
}

export async function runReviewCommand(
  args: string[],
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
  const targetArgs = args.filter((arg) => !arg.startsWith("--"));
  const targetArg = targetArgs[0];
  const post = args.includes("--post");
  const dryRun = args.includes("--dry-run");
  const forceAdversarial = args.includes("--adversarial");
  const skipAdversarial = args.includes("--no-adversarial");
  const knownFlags = new Set([
    "--post",
    "--dry-run",
    "--adversarial",
    "--no-adversarial",
  ]);
  const unknownFlags = args.filter(
    (arg) => arg.startsWith("--") && !knownFlags.has(arg),
  );

  if (unknownFlags.length > 0) {
    throw new Error(`Unknown review option(s): ${unknownFlags.join(", ")}`);
  }
  if (!targetArg) {
    throw new Error("Usage: pnpm review owner/repo#123 [--post] [--dry-run]");
  }
  if (targetArgs.length > 1) {
    throw new Error(
      `Review mode accepts one PR target, received: ${targetArgs.join(", ")}`,
    );
  }
  if (post && dryRun) {
    throw new Error("Use either --post or --dry-run, not both.");
  }
  if (forceAdversarial && skipAdversarial) {
    throw new Error("Use either --adversarial or --no-adversarial, not both.");
  }

  const config = dependencies.loadConfig();
  const token =
    config.githubToken ?? (await activeGhToken(config, dependencies));
  const client = dependencies.createClient(token, config.githubApiUrl);
  const agent = dependencies.getAgent(config.agent, config);
  const adversarialMode: ReviewAdversarialMode = forceAdversarial
    ? "always"
    : skipAdversarial
      ? "off"
      : config.reviewAdversarialMode;
  const adversarialAgent = adversarialAgentFor(
    adversarialMode,
    config,
    dependencies.getAgent,
  );
  const result = await dependencies.reviewPullRequest({
    config,
    github: client,
    git: gitExec,
    state: sqliteState(config),
    agent,
    adversarialAgent,
    adversarialMode,
    target: parseReviewTarget(targetArg),
    post,
    token,
  });
  printReviewResult(result, dependencies.writeLine);
}

/** Without GITHUB_TOKEN, `review` acts as gh's active account. */
async function activeGhToken(
  config: Config,
  dependencies: CliDependencies,
): Promise<string> {
  const accounts = ghAccountsOf(config, dependencies);
  return accounts.token(await accounts.active());
}

function ghAccountsOf(
  config: Config,
  dependencies: CliDependencies,
): GitHubAccountsPort {
  return dependencies.accounts(config, (token) =>
    dependencies.createClient(token, config.githubApiUrl).viewer(),
  );
}

export function printReviewResult(
  result: ReviewRunResult,
  writeLine: (line: string) => void = console.log,
): void {
  const slug = `${result.target.repo.owner}/${result.target.repo.repo}#${result.target.prNumber}`;
  const mode = result.dryRun ? "dry-run" : "posted";
  writeLine(`Review ${mode} for ${slug}`);
  writeLine(result.review.summary);
  writeLine(
    result.adversarialRan
      ? `Adversarial review: ran (${result.adversarialReasons.join(", ")})`
      : `Adversarial review: skipped (${result.adversarialReasons.join(", ")})`,
  );
  if (result.skippedDuplicateFindings > 0) {
    writeLine(`Skipped duplicate findings: ${result.skippedDuplicateFindings}`);
  }
  if (result.skippedUnpostableFindings > 0) {
    writeLine(
      `Skipped unpostable findings: ${result.skippedUnpostableFindings}`,
    );
  }
  if (result.newFindings.length === 0) {
    writeLine("No new actionable findings.");
    return;
  }
  for (const finding of result.newFindings) {
    writeLine(
      `- ${finding.path}:${finding.line} [${finding.severity}] ${finding.body}`,
    );
  }
}

export async function runEntryPoint(
  moduleUrl: string,
  argv: string[] = process.argv,
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<boolean> {
  const script = argv[1];
  if (!script || pathToFileURL(resolve(script)).href !== moduleUrl)
    return false;
  try {
    await runCli(argv.slice(2), dependencies);
  } catch (err) {
    log.error("fatal startup error", {
      error: err instanceof Error ? err.stack : String(err),
    });
    dependencies.exit(1);
  }
  return true;
}

void runEntryPoint(import.meta.url);
