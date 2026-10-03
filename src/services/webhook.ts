import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type { StateFactory } from "../adapters/state/state.interface.js";
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
 * Verifies, dedupes, and normalizes one delivery, then feeds its comments
 * through the same intake and batching the poller uses. The delivery id is
 * recorded before the watched-repo check so a replay is always a duplicate.
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

  const normalized = normalizeDelivery(delivery.event, payload);
  if (normalized.kind === "ignored") return reply(202, normalized.reason);

  const repo =
    normalized.kind === "needs_pull_request"
      ? normalized.repo
      : normalized.events[0].pr.repo;
  const state = ports.state(repo);
  if (state.hasSeenDelivery(delivery.id)) return reply(202, "duplicate");
  state.markDeliverySeen(delivery.id);
  if (!isWatched(config, repo)) return reply(202, "repo-not-watched");

  let events = normalized.kind === "events" ? normalized.events : [];
  if (normalized.kind === "needs_pull_request") {
    const pr = await ports.github.getPullRequest(repo, normalized.prNumber);
    if (pr.draft) return reply(202, "draft");
    if (pr.fromFork) return reply(202, "fork");
    events = normalized.build(pr);
  }

  const now = (ports.now ?? Date.now)();
  const policy: IngestPolicy = {
    allowedAuthors: config.allowedAuthors,
    agentSelfUser: config.agentSelfUser,
  };
  for (const event of events) {
    if (event.kind !== "comment") continue;
    ingestComment({ state, pr: event.pr, comment: event.comment, now, policy });
  }
  const ready = state.takeReadyCommentBatches(now, {
    quietWindowMs: config.commentBatchWindowSec * 1000,
    minComments: config.commentBatchMinComments,
    maxWaitMs: config.commentBatchMaxWaitSec * 1000,
  });
  return { status: 202, reason: "accepted", events, ready };
}

function reply(status: number, reason: string): WebhookResult {
  return { status, reason, events: [], ready: [] };
}

function isWatched(config: Config, repo: RepoRef): boolean {
  return config.repos.some(
    (r) => r.owner === repo.owner && r.repo === repo.repo,
  );
}
