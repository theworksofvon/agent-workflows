import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/**
 * Minimal persistent state. A single JSON file keyed by whatever the caller
 * wants. Per-repo/per-source cursors live here. Kept naive on purpose; the
 * serial queue guarantees no concurrent writes.
 */
export interface State {
  [key: string]: unknown;
}

export class Store {
  private state: State = {};
  private readonly file: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "state.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      log.debug("no state file yet, starting fresh", { file: this.file });
      return;
    }
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch (err) {
      log.warn("failed to parse state file, resetting", {
        file: this.file,
        error: String(err),
      });
      this.state = {};
    }
  }

  get<T>(key: string, fallback: T): T {
    const v = this.state[key];
    return v === undefined ? fallback : (v as T);
  }

  set<T>(key: string, value: T): void {
    this.state[key] = value;
    this.persist();
  }

  update<T>(key: string, fn: (current: T | undefined) => T, initial: T): void {
    const next = fn(this.state[key] as T | undefined);
    this.state[key] = next === undefined ? initial : next;
    this.persist();
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
