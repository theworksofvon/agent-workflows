import { log } from "../log.js";

type Task = () => Promise<void>;

interface Entry {
  task: Task;
  slots: number;
}

/**
 * Per-lane serial execution with a global cap on slots. A lane is one PR,
 * so two runs never race on the same branch, while different PRs proceed in
 * parallel up to `maxConcurrent` slots. A task takes one slot for each agent
 * process it runs at the same time.
 */
export class Dispatcher {
  private readonly lanes = new Map<string, Entry[]>();
  private readonly active = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private runningCount = 0;
  private usedSlots = 0;

  constructor(private readonly maxConcurrent: number) {}

  /**
   * `slots` is capped at the global cap, so a task wider than the cap still
   * runs, alone.
   */
  enqueue(lane: string, task: Task, slots = 1): void {
    const queue = this.lanes.get(lane) ?? [];
    queue.push({ task, slots: Math.min(slots, this.maxConcurrent) });
    this.lanes.set(lane, queue);
    this.pump();
  }

  idle(): Promise<void> {
    if (this.runningCount === 0 && this.queued === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Waits up to `ms` for every task to finish. Resolves true when they did,
   * false when the time ran out first.
   */
  async drain(
    ms: number,
    setTimer: typeof setTimeout = setTimeout,
    clearTimer: typeof clearTimeout = clearTimeout,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimer(() => resolve(false), ms);
    });
    const idle = await Promise.race([
      this.idle().then(() => true as const),
      timedOut,
    ]);
    clearTimer(timer);
    return idle;
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
      if (this.active.has(lane) || queue.length === 0) continue;
      // Waiting here, rather than starting a smaller task, keeps a wide task
      // from waiting forever behind narrow ones.
      if (this.usedSlots + queue[0].slots > this.maxConcurrent) break;
      const { task, slots } = queue.shift()!;
      this.active.add(lane);
      this.runningCount += 1;
      this.usedSlots += slots;
      void Promise.resolve()
        .then(task)
        .catch((err) =>
          log.error("dispatched task failed", { lane, error: String(err) }),
        )
        .finally(() => {
          this.active.delete(lane);
          this.runningCount -= 1;
          this.usedSlots -= slots;
          if (queue.length === 0) this.lanes.delete(lane);
          this.pump();
          if (this.runningCount === 0 && this.queued === 0) {
            for (const w of this.waiters.splice(0)) w();
          }
        });
    }
  }
}
