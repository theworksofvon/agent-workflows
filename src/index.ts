import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { GitHubClient } from "./github/client.js";
import { githubPoller } from "./github/poller.js";
import { getAgent } from "./agents/registry.js";
import { registerBuiltins } from "./workflows/registry.js";
import { Daemon } from "./daemon.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.stateDir);
  const client = new GitHubClient(config.githubToken);
  const agent = getAgent(config.agent, config);

  registerBuiltins();

  const source = githubPoller({ config, store, client });
  const daemon = new Daemon(config, store, source, client, agent);

  // Graceful shutdown.
  const stop = (sig: string) => {
    log.info("shutting down", { signal: sig });
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await daemon.start();
}

main().catch((err) => {
  log.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
