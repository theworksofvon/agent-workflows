import { log } from "../log.js";

type Task = () => Promise<void>;

/**
 * Per-lane serial execution with a global concurrency cap. A lane is one PR,
 * so two runs never race on the same branch, while different PRs proceed in
 * parallel up to `maxConcurrent`.
 */
export class Dispatcher {
  private readonly lanes = new Map<string, Task[]>();
  private readonly active = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private runningCount = 0;

  constructor(private readonly maxConcurrent: number) {}

  enqueue(lane: string, task: Task): void {
    const queue = this.lanes.get(lane) ?? [];
    queue.push(task);
    this.lanes.set(lane, queue);
    this.pump();
  }

  idle(): Promise<void> {
    if (this.runningCount === 0 && this.queued === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get running(): number {
    return this.runningCount;
  }

  get queued(): number {
    let n = 0;
    for (const q of this.lanes.values()) n += q.length;
    return n;
  }

  private pump(): void {
    for (const [lane, queue] of this.lanes) {
      if (this.runningCount >= this.maxConcurrent) break;
      if (this.active.has(lane) || queue.length === 0) continue;
      const task = queue.shift()!;
      this.active.add(lane);
      this.runningCount += 1;
      void Promise.resolve()
        .then(task)
        .catch((err) =>
          log.error("dispatched task failed", { lane, error: String(err) }),
        )
        .finally(() => {
          this.active.delete(lane);
          this.runningCount -= 1;
          if (queue.length === 0) this.lanes.delete(lane);
          this.pump();
          if (this.runningCount === 0 && this.queued === 0) {
            for (const w of this.waiters.splice(0)) w();
          }
        });
    }
  }
}
