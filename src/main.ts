import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import type { Config, ReviewAdversarialMode } from "./config.js";
import { GitHubClient } from "./adapters/github/octokit.js";
import { pollRepos } from "./services/poll.js";
import { jsonFileState } from "./adapters/state/json-file.js";
import { gitExec } from "./adapters/git/exec.js";
import type { StateFactory } from "./adapters/state/state.interface.js";
import type { GitPort } from "./adapters/git/git.interface.js";
import type { CommentBatch } from "./domain/events.js";
import { getAgent } from "./adapters/agent/registry.js";
import type { AgentAdapter } from "./adapters/agent/agent.interface.js";
import { Daemon } from "./services/daemon.js";
import {
  handleFeedback,
  type FeedbackPorts,
} from "./services/handle-feedback.js";
import { log } from "./log.js";
import { parseReviewTarget } from "./domain/target.js";
import { reviewPullRequest } from "./services/review-pr.js";
import type { ReviewRunResult } from "./services/review-pr.js";

export interface CliDependencies {
  loadConfig(options: { requireRepos: boolean }): Config;
  createClient(token: string): GitHubClient;
  getAgent(name: string, config: Config): AgentAdapter;
  createPoll(args: {
    config: Config;
    client: GitHubClient;
    state?: StateFactory;
  }): () => Promise<CommentBatch[]>;
  createDaemon(args: {
    config: Config;
    poll: () => Promise<CommentBatch[]>;
    client: GitHubClient;
    agent: AgentAdapter;
    git?: GitPort;
    state?: StateFactory;
  }): Pick<Daemon, "start" | "stop" | "dispatchEvents" | "idle">;
  reviewPullRequest: typeof reviewPullRequest;
  onSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code: number): void;
  writeLine(line: string): void;
}

export const defaultCliDependencies: CliDependencies = {
  loadConfig,
  createClient: (token) => new GitHubClient(token),
  getAgent,
  createPoll: ({ config, client, state = jsonFileState(config) }) => {
    return () => pollRepos({ config, client, state });
  },
  createDaemon: ({
    config,
    poll,
    client,
    agent,
    git = gitExec,
    state = jsonFileState(config),
  }) => {
    const ports: FeedbackPorts = {
      config,
      agent,
      git,
      github: client,
      state,
    };
    return new Daemon({
      config,
      poll,
      handleBatch: (batch) => handleFeedback(batch, ports),
      reviewPullRequest: (target) =>
        reviewPullRequest({
          config,
          github: client,
          git,
          state,
          agent,
          adversarialAgent: adversarialAgentFor(
            config.reviewAdversarialMode,
            config,
            getAgent,
          ),
          adversarialMode: config.reviewAdversarialMode,
          target,
          post: true,
        }),
    });
  },
  reviewPullRequest,
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

export async function runCli(
  args: string[],
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printHelp(dependencies.writeLine);
    return;
  }
  if (args[0] === "review") {
    if (args[1] === "--help" || args[1] === "-h" || args[1] === "help") {
      printHelp(dependencies.writeLine);
      return;
    }
    await runReviewCommand(args.slice(1), dependencies);
    return;
  }

  const config = dependencies.loadConfig({ requireRepos: true });
  const client = dependencies.createClient(config.githubToken);
  const agent = dependencies.getAgent(config.agent, config);

  // Poll and handlers must share one store per repo or they overwrite each other.
  const state = jsonFileState(config);
  const poll = dependencies.createPoll({ config, client, state });
  const daemon = dependencies.createDaemon({
    config,
    poll,
    client,
    agent,
    state,
  });

  const stop = (sig: "SIGINT" | "SIGTERM") => {
    log.info("shutting down", { signal: sig });
    daemon.stop();
    dependencies.exit(0);
  };
  dependencies.onSignal("SIGINT", () => stop("SIGINT"));
  dependencies.onSignal("SIGTERM", () => stop("SIGTERM"));

  await daemon.start();
}

export function printHelp(
  writeLine: (line: string) => void = console.log,
): void {
  writeLine(`agent-workflows

Usage:
  pnpm start
  pnpm review owner/repo#123 [--post] [--adversarial|--no-adversarial]

Commands:
  daemon   Poll configured repositories and process ready comment batches (default)
  review   Run a read-only pull-request review; add --post to publish findings
  help     Show this message`);
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

  const config = dependencies.loadConfig({ requireRepos: false });
  const client = dependencies.createClient(config.githubToken);
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
    state: jsonFileState(config),
    agent,
    adversarialAgent,
    adversarialMode,
    target: parseReviewTarget(targetArg),
    post,
  });
  printReviewResult(result, dependencies.writeLine);
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
