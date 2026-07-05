import type { Config } from "./config.js";
import type { Source } from "./sources/types.js";
import type { RunCtx } from "./workflows/types.js";
import type { GitHubClient } from "./github/client.js";
import type { AgentAdapter } from "./agents/types.js";
import { SerialQueue } from "./queue.js";
import { getWorkflow } from "./workflows/registry.js";
import { log } from "./log.js";

/**
 * The daemon: owns the poll loop, the serial queue, and dispatches events to
 * the matching workflow. Building the RunCtx (config + agent + the
 * marker-comment helper) happens here so workflows stay pure.
 */
export class Daemon {
  private readonly queue = new SerialQueue();
  private polling = false;

  constructor(
    private readonly config: Config,
    private readonly source: Source,
    private readonly client: GitHubClient,
    private readonly agent: AgentAdapter,
  ) {}

  async start(): Promise<void> {
    log.info("daemon started", {
      source: this.source.name,
      agent: this.agent.name,
      pollIntervalSec: this.config.pollIntervalSec,
    });
    // First poll immediately so you don't wait a full interval on launch.
    await this.tick();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    setTimeout(() => {
      this.tick().finally(() => this.scheduleNext());
    }, this.config.pollIntervalSec * 1000);
  }

  private async tick(): Promise<void> {
    // Skip overlapping polls — if the last one is still draining, wait.
    if (this.polling) {
      log.debug("previous poll still running, skipping tick");
      return;
    }
    this.polling = true;
    try {
      const events = await this.source.poll();
      for (const event of events) {
        const wf = getWorkflow(event.kind);
        if (!wf) {
          log.warn("no workflow registered for event kind", { kind: event.kind, id: event.id });
          continue;
        }
        const ctx = this.makeRunCtx();
        this.queue.enqueue(() => wf.handle(event, ctx));
      }
    } catch (err) {
      log.error("poll tick failed", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }

  private makeRunCtx(): RunCtx {
    return {
      config: this.config,
      agent: this.agent,
      postMarkerComment: async ({ repo, prNumber, body }) => {
        await this.client.createComment(repo, prNumber, body);
      },
    };
  }
}
