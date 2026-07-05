import { loadConfig } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { githubPoller } from "./github/poller.js";
import { getAgent } from "./agents/registry.js";
import { registerBuiltins } from "./workflows/registry.js";
import { Daemon } from "./daemon.js";
import { log } from "./log.js";
import { parseReviewTarget } from "./workflows/pr-review/target.js";
import { PullRequestReviewWorkflow } from "./workflows/pr-review/index.js";
import type { PullRequestReviewRunResult } from "./workflows/pr-review/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "review") {
    await runReviewCommand(args.slice(1));
    return;
  }

  const config = loadConfig({ requireRepos: true });
  const client = new GitHubClient(config.githubToken);
  const agent = getAgent(config.agent, config);

  registerBuiltins();

  const source = githubPoller({ config, client });
  const daemon = new Daemon(config, source, client, agent);

  // Graceful shutdown.
  const stop = (sig: string) => {
    log.info("shutting down", { signal: sig });
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await daemon.start();
}

async function runReviewCommand(args: string[]): Promise<void> {
  const targetArgs = args.filter((arg) => !arg.startsWith("--"));
  const targetArg = targetArgs[0];
  const post = args.includes("--post");
  const dryRun = args.includes("--dry-run");
  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--post" && arg !== "--dry-run");

  if (unknownFlags.length > 0) {
    throw new Error(`Unknown review option(s): ${unknownFlags.join(", ")}`);
  }
  if (!targetArg) {
    throw new Error("Usage: npm run review -- owner/repo#123 [--post] [--dry-run]");
  }
  if (targetArgs.length > 1) {
    throw new Error(`Review mode accepts one PR target, received: ${targetArgs.join(", ")}`);
  }
  if (post && dryRun) {
    throw new Error("Use either --post or --dry-run, not both.");
  }

  const config = loadConfig({ requireRepos: false });
  const client = new GitHubClient(config.githubToken);
  const agent = getAgent(config.agent, config);
  const workflow = new PullRequestReviewWorkflow();
  const result = await workflow.run({
    config,
    client,
    agent,
    target: parseReviewTarget(targetArg),
    post,
  });
  printReviewResult(result);
}

function printReviewResult(result: PullRequestReviewRunResult): void {
  const slug = `${result.target.repo.owner}/${result.target.repo.repo}#${result.target.prNumber}`;
  const mode = result.dryRun ? "dry-run" : "posted";
  console.log(`Review ${mode} for ${slug}`);
  console.log(result.review.summary);
  if (result.skippedDuplicateFindings > 0) {
    console.log(`Skipped duplicate findings: ${result.skippedDuplicateFindings}`);
  }
  if (result.newFindings.length === 0) {
    console.log("No new actionable findings.");
    return;
  }
  for (const finding of result.newFindings) {
    console.log(`- ${finding.path}:${finding.line} [${finding.severity}] ${finding.body}`);
  }
}

main().catch((err) => {
  log.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
