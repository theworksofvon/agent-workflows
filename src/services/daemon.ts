import type { Config } from "../config.js";
import type {
  CommentBatch,
  DomainEvent,
  RawDelivery,
  RepoRef,
  ReviewTarget,
} from "../domain/events.js";
import { Dispatcher } from "./dispatch.js";
import type { WebhookResult } from "./webhook.js";
import { log } from "../log.js";

export interface WebhookListener {
  url: string;
  close(): Promise<void>;
}

export type StartListener = (args: {
  host: string;
  port: number;
  onDelivery: (
    delivery: RawDelivery,
  ) => Promise<{ status: number; reason: string }>;
}) => Promise<WebhookListener>;

export interface DaemonPorts {
  config: Config;
  poll: () => Promise<CommentBatch[]>;
  handleBatch: (batch: CommentBatch) => Promise<unknown>;
  reviewPullRequest?: (target: ReviewTarget) => Promise<unknown>;
  dispatcher?: Dispatcher;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** The listener opens only when all three webhook ports are present. */
  listener?: { host: string; port: number };
  receiveDelivery?: (delivery: RawDelivery) => Promise<WebhookResult>;
  startListener?: StartListener;
}

function laneFor(repo: RepoRef, prNumber: number): string {
  return `${repo.owner}/${repo.repo}#${prNumber}`;
}

/**
 * The daemon: owns the poll loop and the webhook listener, and hands work
 * from both to the dispatcher, which keeps each PR serial and caps total
 * concurrency.
 */
export class Daemon {
  private readonly dispatcher: Dispatcher;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private polling = false;
  private running = false;
  private lifecycleGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private webhookListener: WebhookListener | undefined;

  constructor(private readonly ports: DaemonPorts) {
    this.dispatcher =
      ports.dispatcher ?? new Dispatcher(ports.config.maxConcurrentRuns);
    this.setTimer = ports.setTimeout ?? setTimeout;
    this.clearTimer = ports.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.lifecycleGeneration;
    log.info("daemon started", {
      pollIntervalSec: this.ports.config.pollIntervalSec,
    });
    try {
      await this.openListener(generation);
    } catch (err) {
      await this.stop();
      throw err;
    }
    if (!this.isCurrentRun(generation)) return;
    // First poll immediately so you don't wait a full interval on launch.
    await this.tick();
    if (this.isCurrentRun(generation)) this.scheduleNext(generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.lifecycleGeneration += 1;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const listener = this.webhookListener;
    this.webhookListener = undefined;
    if (listener) await listener.close();
  }

  private async openListener(generation: number): Promise<void> {
    const { listener, receiveDelivery, startListener } = this.ports;
    if (!listener || !receiveDelivery || !startListener) return;
    const handle = await startListener({
      ...listener,
      onDelivery: async (delivery) => {
        const result = await receiveDelivery(delivery);
        this.dispatchEvents(result.events, result.ready);
        return result;
      },
    });
    // A stop that landed while the port was opening must not leak it.
    if (!this.isCurrentRun(generation)) return handle.close();
    this.webhookListener = handle;
    log.info("webhook listener started", { url: handle.url });
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
      this.dispatchEvents([], await this.ports.poll());
    } catch (err) {
      log.error("poll tick failed", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }

  /** Entry for webhook-sourced events; same lanes as polled batches. */
  dispatchEvents(events: DomainEvent[], ready: CommentBatch[]): void {
    const { config, reviewPullRequest, handleBatch } = this.ports;
    if (config.autoReview && reviewPullRequest) {
      for (const event of events) {
        if (event.kind !== "pull_request_ready") continue;
        const target = { repo: event.pr.repo, prNumber: event.pr.number };
        this.dispatcher.enqueue(
          laneFor(target.repo, target.prNumber),
          async () => {
            await reviewPullRequest(target);
          },
        );
      }
    }
    for (const batch of ready) {
      this.dispatcher.enqueue(laneFor(batch.repo, batch.prNumber), async () => {
        await handleBatch(batch);
      });
    }
  }

  idle(): Promise<void> {
    return this.dispatcher.idle();
  }
}
