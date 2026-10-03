import type { CommentBatch } from "../domain/events.js";
import { SerialQueue } from "./queue.js";
import { handleFeedback, type FeedbackPorts } from "./handle-feedback.js";
import { log } from "../log.js";

export interface DaemonDependencies {
  queue?: SerialQueue;
  handleFeedback?: (
    batch: CommentBatch,
    ports: FeedbackPorts,
  ) => Promise<unknown>;
  setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The daemon: owns the poll loop, the serial queue, and dispatches comment
 * batches to feedback handling with the ports it was constructed with.
 */
export class Daemon {
  private readonly queue: SerialQueue;
  private readonly handle: NonNullable<DaemonDependencies["handleFeedback"]>;
  private readonly setTimer: NonNullable<DaemonDependencies["setTimeout"]>;
  private readonly clearTimer: NonNullable<DaemonDependencies["clearTimeout"]>;
  private polling = false;
  private running = false;
  private lifecycleGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ports: FeedbackPorts,
    private readonly poll: () => Promise<CommentBatch[]>,
    dependencies: DaemonDependencies = {},
  ) {
    this.queue = dependencies.queue ?? new SerialQueue();
    this.handle = dependencies.handleFeedback ?? handleFeedback;
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.lifecycleGeneration;
    log.info("daemon started", {
      agent: this.ports.agent.name,
      pollIntervalSec: this.ports.config.pollIntervalSec,
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
    }, this.ports.config.pollIntervalSec * 1000);
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
      const batches = await this.poll();
      for (const batch of batches) {
        this.queue.enqueue(async () => {
          await this.handle(batch, this.ports);
        });
      }
    } catch (err) {
      log.error("poll tick failed", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }
}
