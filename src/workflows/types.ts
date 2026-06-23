import type { Config } from "../config.js";
import type { Event } from "../sources/types.js";
import type { AgentAdapter } from "../agents/types.js";

/**
 * Handed to every workflow's handle(). Bundle of the things a workflow needs
 * to do its job without it reaching into globals. Add fields here as new
 * workflows need them.
 */
export interface RunCtx {
  config: Config;
  agent: AgentAdapter;
  /** Post a PR comment tagged so the daemon ignores it (loop prevention). */
  postMarkerComment(args: {
    repo: { owner: string; repo: string };
    prNumber: number;
    body: string;
  }): Promise<void>;
}

export interface Workflow {
  /** Event kind this workflow handles. */
  readonly kind: string;
  handle(event: Event, ctx: RunCtx): Promise<void>;
}
