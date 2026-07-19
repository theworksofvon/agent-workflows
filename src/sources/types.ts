/**
 * Source seam — where events come from.
 *
 * Today: a GitHub poller. Tomorrow: webhooks, websocket, file watchers.
 * A source just needs to produce events on demand.
 */

export interface Event<Payload = unknown> {
  /** Event kind, matched against Workflow.kind. e.g. "pr_comment". */
  kind: string;
  /** Opaque payload; the matching workflow knows its shape. */
  payload: Payload;
  /** Stable id for dedup/logging. */
  id: string;
}

export interface Source<Payload = unknown> {
  /** Human-readable name for logs. */
  readonly name: string;
  /** Return events seen since the last poll. Sources own their own cursor. */
  poll(): Promise<Array<Event<Payload>>>;
}
