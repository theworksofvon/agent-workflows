/**
 * Source seam — where events come from.
 *
 * Today: a GitHub poller. Tomorrow: webhooks, websocket, file watchers.
 * A source just needs to produce events on demand.
 */

export interface Event {
  /** Event kind, matched against Workflow.kind. e.g. "pr_comment". */
  kind: string;
  /** Opaque payload; the matching workflow knows its shape. */
  payload: unknown;
  /** Stable id for dedup/logging. */
  id: string;
}

export interface Source {
  /** Human-readable name for logs. */
  readonly name: string;
  /** Return events seen since the last poll. Sources own their own cursor. */
  poll(): Promise<Event[]>;
}
