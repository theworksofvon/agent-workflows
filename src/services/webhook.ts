import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type {
  RepoStatePort,
  StateFactory,
} from "../adapters/state/state.interface.js";
import type { IngestPolicy } from "../domain/batching.js";
import type {
  CommentBatch,
  DomainEvent,
  RawDelivery,
  RepoRef,
} from "../domain/events.js";
import { normalizeDelivery } from "../domain/webhook.js";
import { ingestComment } from "./intake.js";

export interface WebhookPorts {
  config: Config;
  github: Pick<GitHubPort, "getPullRequest">;
  state: StateFactory;
  now?: () => number;
}

export interface WebhookResult {
  status: number;
  reason: string;
  events: DomainEvent[];
  ready: CommentBatch[];
}

/** Checks GitHub's `X-Hub-Signature-256` header against the raw body. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature256: string | null,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature256 ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
}

/**
 * Verifies, normalizes, and dedupes one delivery, then feeds its comments
 * through the same intake and batching the poller uses. Unwatched repos are
 * rejected before any state is touched.
 */
export async function receiveDelivery(
  delivery: RawDelivery,
  ports: WebhookPorts,
): Promise<WebhookResult> {
  const { config } = ports;
  if (config.webhookSecret === null) return reply(503, "webhooks-disabled");
  if (
    !verifyWebhookSignature(
      config.webhookSecret,
      delivery.body,
      delivery.signature256,
    )
  )
    return reply(401, "bad-signature");

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.body);
  } catch {
    return reply(400, "bad-json");
  }

  const normalized = normalizeDelivery(delivery.event, payload, (repo) =>
    watchedRepo(config, repo),
  );
  if (normalized.kind === "ignored") return reply(202, normalized.reason);

  const repo =
    normalized.kind === "needs_pull_request"
      ? normalized.repo
      : normalized.events[0].pr.repo;
  const state = ports.state(repo);
  if (state.hasSeenDelivery(delivery.id)) return reply(202, "duplicate");

  let events = normalized.kind === "events" ? normalized.events : [];
  if (normalized.kind === "needs_pull_request") {
    const pr = await ports.github.getPullRequest(repo, normalized.prNumber);
    if (pr.draft) return reply(202, "draft");
    if (pr.fromFork) return reply(202, "fork");
    events = normalized.build(pr);
  }
  // Marked only once the PR lookup succeeded, so GitHub's redelivery of a
  // failed attempt is processed instead of answered "duplicate".
  state.markDeliverySeen(delivery.id);

  const now = (ports.now ?? Date.now)();
  const policy: IngestPolicy = {
    allowedAuthors: config.allowedAuthors,
    agentSelfUser: config.agentSelfUser,
  };
  for (const event of events) {
    if (event.kind !== "comment") continue;
    ingestComment({ state, pr: event.pr, comment: event.comment, now, policy });
  }
  return {
    status: 202,
    reason: "accepted",
    events,
    ready: takeReadyFrom(state, config, now),
  };
}

/** Pulls whatever batches are ready for one repo under the configured policy. */
export function takeReadyBatches(
  repo: RepoRef,
  ports: Pick<WebhookPorts, "config" | "state" | "now">,
): CommentBatch[] {
  return takeReadyFrom(
    ports.state(repo),
    ports.config,
    (ports.now ?? Date.now)(),
  );
}

function takeReadyFrom(
  state: RepoStatePort,
  config: Config,
  now: number,
): CommentBatch[] {
  return state.takeReadyCommentBatches(now, {
    quietWindowMs: config.commentBatchWindowSec * 1000,
    minComments: config.commentBatchMinComments,
    maxWaitMs: config.commentBatchMaxWaitSec * 1000,
  });
}

function reply(status: number, reason: string): WebhookResult {
  return { status, reason, events: [], ready: [] };
}

/** GitHub names are case-insensitive; the config's casing keys state. */
function watchedRepo(config: Config, repo: RepoRef): RepoRef | null {
  const owner = repo.owner.toLowerCase();
  const name = repo.repo.toLowerCase();
  const spec = config.repos.find(
    (r) => r.owner.toLowerCase() === owner && r.repo.toLowerCase() === name,
  );
  return spec ? { owner: spec.owner, repo: spec.repo } : null;
}
