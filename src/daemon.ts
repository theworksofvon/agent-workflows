import type { Config } from "./config.js";
import type { Source } from "./sources/types.js";
import type { RunCtx } from "./workflows/types.js";
import type { GitHubClient } from "./github/client.js";
import type { AgentAdapter } from "./agents/types.js";
import { SerialQueue } from "./queue.js";
import { getWorkflow } from "./workflows/registry.js";
import { log } from "./log.js";

export interface DaemonDependencies {
  queue?: SerialQueue;
  getWorkflow?: typeof getWorkflow;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The daemon: owns the poll loop, the serial queue, and dispatches events to
 * the matching workflow. Building the RunCtx (config + agent + the
 * marker-comment helper) happens here so workflows stay pure.
 */
export class Daemon {
  private readonly queue: SerialQueue;
  private readonly findWorkflow: typeof getWorkflow;
  private readonly setTimer: NonNullable<DaemonDependencies["setTimeout"]>;
  private readonly clearTimer: NonNullable<DaemonDependencies["clearTimeout"]>;
  private polling = false;
  private running = false;
  private lifecycleGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly config: Config,
    private readonly source: Source,
    private readonly client: Pick<GitHubClient, "createComment">,
    private readonly agent: AgentAdapter,
    dependencies: DaemonDependencies = {},
  ) {
    this.queue = dependencies.queue ?? new SerialQueue();
    this.findWorkflow = dependencies.getWorkflow ?? getWorkflow;
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.lifecycleGeneration;
    log.info("daemon started", {
      source: this.source.name,
      agent: this.agent.name,
      pollIntervalSec: this.config.pollIntervalSec,
    });
    // First poll immediately so you don't wait a full interval on launch.
    await this.tick();
    if (this.isCurrentRun(generation)) this.scheduleNext(generation);
  }

  stop(): void {
    this.running = false;
    this.lifecycleGeneration += 1;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(generation: number): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.tick().finally(() => {
        if (this.isCurrentRun(generation)) this.scheduleNext(generation);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  private isCurrentRun(generation: number): boolean {
    return this.running && generation === this.lifecycleGeneration;
  }

  async tick(): Promise<void> {
    // Skip overlapping polls — if the last one is still draining, wait.
    if (this.polling) {
      log.debug("previous poll still running, skipping tick");
      return;
    }
    this.polling = true;
    try {
      const events = await this.source.poll();
      for (const event of events) {
        const wf = this.findWorkflow(event.kind);
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
