import { log } from "./log.js";

type Task = () => Promise<void>;

/**
 * Serial task queue. One task runs at a time — critical so concurrent PR
 * workflows never race on git push or the state file. Adding concurrency
 * later is a matter of swapping this class; callers don't change.
 */
export class SerialQueue {
  private queue: Task[] = [];
  private running = false;

  enqueue(task: Task): void {
    this.queue.push(task);
    void this.drain();
  }

  get size(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        try {
          await next();
        } catch (err) {
          log.error("task failed", { error: String(err) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
