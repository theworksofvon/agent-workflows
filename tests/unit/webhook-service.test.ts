import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { GitHubRepoStateStore } from "../../src/adapters/state/json-file.js";
import type { PullRequest, RawDelivery } from "../../src/domain/events.js";
import {
  receiveDelivery,
  verifyWebhookSignature,
  type WebhookPorts,
} from "../../src/services/webhook.js";

const repository = { name: "r", owner: { login: "o" } };
const rawPr = {
  number: 4,
  title: "T",
  body: null,
  draft: false,
  head: { ref: "f", repo: { full_name: "o/r" } },
  base: { ref: "main", repo: { full_name: "o/r" } },
};
const pr: PullRequest = {
  repo: { owner: "o", repo: "r" },
  number: 4,
  title: "T",
  body: null,
  headRef: "f",
  baseRef: "main",
  draft: false,
  fromFork: false,
};

const reviewCommentPayload = {
  action: "created",
  repository,
  comment: {
    id: 5,
    user: { login: "alice" },
    body: "fix",
    created_at: "2026-01-01T00:00:00Z",
    path: "a.ts",
    line: 3,
    original_line: 3,
    diff_hunk: "@@",
    pull_request_review_id: 9,
  },
  pull_request: rawPr,
};

const issueCommentPayload = {
  action: "created",
  repository,
  issue: { number: 4, pull_request: { url: "u" } },
  comment: {
    id: 7,
    user: { login: "bob" },
    body: "please fix",
    created_at: "2026-01-02T00:00:00Z",
  },
};

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", "s").update(body).digest("hex");
}

function delivery(event: string, payload: unknown, id = "d1"): RawDelivery {
  const body = JSON.stringify(payload);
  return { id, event, signature256: sign(body), body };
}

function config(root: string, over: Partial<Config> = {}): Config {
  return {
    githubToken: "t",
    repos: [{ owner: "o", repo: "r" }],
    pollIntervalSec: 300,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 2,
    agentMaxAttempts: 3,
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    allowedAuthors: null,
    stateDir: join(root, "state"),
    zcodeBin: "z",
    claudeCodeBin: "c",
    codexBin: "x",
    keepWorkdirs: false,
    host: "127.0.0.1",
    port: 3773,
    webhookSecret: "s",
    publicUrl: null,
    tailscaleFunnel: false,
    maxConcurrentRuns: 3,
    autoReview: false,
    ...over,
  };
}

function harness(
  over: Partial<Config> = {},
  fetched: PullRequest = pr,
): {
  ports: WebhookPorts;
  stores: Map<string, GitHubRepoStateStore>;
  fetches: Array<{ repo: unknown; prNumber: number }>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "aw-webhook-"));
  const cfg = config(root, over);
  const stores = new Map<string, GitHubRepoStateStore>();
  const fetches: Array<{ repo: unknown; prNumber: number }> = [];
  return {
    stores,
    fetches,
    ports: {
      config: cfg,
      now: () => 1_000,
      github: {
        async getPullRequest(repo, prNumber) {
          fetches.push({ repo, prNumber });
          return fetched;
        },
      },
      state: (repo) => {
        const key = `${repo.owner}/${repo.repo}`;
        let store = stores.get(key);
        if (!store) {
          store = new GitHubRepoStateStore(cfg.stateDir, repo, {
            processedCommentKeyLimit: 10,
            commentBatchHistoryLimit: 5,
          });
          stores.set(key, store);
        }
        return store;
      },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("webhooks are disabled without a secret", async () => {
  const h = harness({ webhookSecret: null });
  try {
    const result = await receiveDelivery(
      delivery("pull_request_review_comment", reviewCommentPayload),
      h.ports,
    );
    assert.deepEqual(result, {
      status: 503,
      reason: "webhooks-disabled",
      events: [],
      ready: [],
    });
  } finally {
    h.cleanup();
  }
});

test("a delivery with a bad signature is rejected", async () => {
  const h = harness();
  try {
    const result = await receiveDelivery(
      { ...delivery("pull_request", {}), signature256: sign("other") },
      h.ports,
    );
    assert.equal(result.status, 401);
    assert.equal(result.reason, "bad-signature");
  } finally {
    h.cleanup();
  }
});

test("a signed body that is not JSON is rejected", async () => {
  const h = harness();
  try {
    const body = "{not json";
    const result = await receiveDelivery(
      { id: "d1", event: "pull_request", signature256: sign(body), body },
      h.ports,
    );
    assert.equal(result.status, 400);
    assert.equal(result.reason, "bad-json");
  } finally {
    h.cleanup();
  }
});

test("an ignored delivery reports the normalizer's reason", async () => {
  const h = harness();
  try {
    const result = await receiveDelivery(
      delivery("push", { repository }),
      h.ports,
    );
    assert.deepEqual(result, {
      status: 202,
      reason: "unsupported-event",
      events: [],
      ready: [],
    });
  } finally {
    h.cleanup();
  }
});

test("a review comment delivery is ingested and its batch is ready", async () => {
  const h = harness();
  try {
    const result = await receiveDelivery(
      delivery("pull_request_review_comment", reviewCommentPayload),
      h.ports,
    );
    assert.equal(result.status, 202);
    assert.equal(result.reason, "accepted");
    assert.equal(result.events.length, 1);
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0].comments[0].key, "o/r#4:review:5");
    const store = h.stores.get("o/r");
    // Only the poller moves cursors, so a lost delivery is still reconciled.
    assert.equal(store?.getReviewCommentCursor(4), 0);
    assert.equal(store?.hasSeenDelivery("d1"), true);
  } finally {
    h.cleanup();
  }
});

test("a redelivered id is reported as a duplicate and not re-ingested", async () => {
  const h = harness();
  try {
    const first = delivery("pull_request_review_comment", reviewCommentPayload);
    await receiveDelivery(first, h.ports);
    const second = await receiveDelivery(first, h.ports);
    assert.deepEqual(second, {
      status: 202,
      reason: "duplicate",
      events: [],
      ready: [],
    });
  } finally {
    h.cleanup();
  }
});

test("a delivery whose PR lookup fails is not marked seen, so redelivery works", async () => {
  const h = harness();
  const fetchPr = h.ports.github.getPullRequest;
  let fail = true;
  h.ports.github = {
    async getPullRequest(repo, prNumber) {
      if (fail) throw new Error("github 502");
      return fetchPr(repo, prNumber);
    },
  };
  try {
    const d = delivery("issue_comment", issueCommentPayload);
    await assert.rejects(receiveDelivery(d, h.ports), /github 502/);
    assert.equal(h.stores.get("o/r")?.hasSeenDelivery("d1"), false);
    fail = false;
    const retried = await receiveDelivery(d, h.ports);
    assert.equal(retried.reason, "accepted");
    assert.equal(retried.ready.length, 1);
  } finally {
    h.cleanup();
  }
});

test("an issue_comment delivery fetches the PR once and ingests it", async () => {
  const h = harness();
  try {
    const result = await receiveDelivery(
      delivery("issue_comment", issueCommentPayload),
      h.ports,
    );
    assert.deepEqual(h.fetches, [
      { repo: { owner: "o", repo: "r" }, prNumber: 4 },
    ]);
    assert.equal(result.reason, "accepted");
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0].comments[0].key, "o/r#4:issue:7");
    assert.equal(result.ready[0].headRef, "f");
  } finally {
    h.cleanup();
  }
});

test("an issue_comment on a fetched draft or fork PR is ignored", async () => {
  for (const [over, reason] of [
    [{ draft: true }, "draft"],
    [{ fromFork: true }, "fork"],
  ] as const) {
    const h = harness({}, { ...pr, ...over });
    try {
      const result = await receiveDelivery(
        delivery("issue_comment", issueCommentPayload),
        h.ports,
      );
      assert.deepEqual(result, { status: 202, reason, events: [], ready: [] });
      assert.equal(h.stores.get("o/r")?.getIssueCommentCursor(4), 0);
    } finally {
      h.cleanup();
    }
  }
});

test("a delivery for an unwatched repo never touches state", async () => {
  const h = harness({ repos: [{ owner: "o", repo: "other" }] });
  try {
    const result = await receiveDelivery(
      delivery("issue_comment", issueCommentPayload),
      h.ports,
    );
    assert.deepEqual(result, {
      status: 202,
      reason: "repo-not-watched",
      events: [],
      ready: [],
    });
    assert.deepEqual(h.fetches, []);
    assert.equal(h.stores.size, 0);
    assert.equal(
      existsSync(join(h.ports.config.stateDir, "github", "o")),
      false,
    );
  } finally {
    h.cleanup();
  }
});

test("repo matching ignores case and keys state by the config's casing", async () => {
  const h = harness({ repos: [{ owner: "Owner", repo: "Repo" }] });
  try {
    const result = await receiveDelivery(
      delivery("pull_request_review_comment", {
        ...reviewCommentPayload,
        repository: { name: "repo", owner: { login: "owner" } },
      }),
      h.ports,
    );
    assert.equal(result.reason, "accepted");
    assert.deepEqual(result.ready[0].repo, { owner: "Owner", repo: "Repo" });
    assert.equal(result.ready[0].comments[0].key, "Owner/Repo#4:review:5");
    const stateDir = h.ports.config.stateDir;
    assert.deepEqual(readdirSync(join(stateDir, "github")), ["Owner"]);
    assert.deepEqual(readdirSync(join(stateDir, "github", "Owner")), [
      "Repo.json",
    ]);
    assert.equal(h.stores.get("Owner/Repo")?.hasSeenDelivery("d1"), true);
  } finally {
    h.cleanup();
  }
});

test("pull_request opened yields a ready event and no batches", async () => {
  const h = harness();
  delete h.ports.now;
  try {
    const result = await receiveDelivery(
      delivery("pull_request", {
        action: "opened",
        repository,
        pull_request: rawPr,
      }),
      h.ports,
    );
    assert.deepEqual(result, {
      status: 202,
      reason: "accepted",
      events: [{ kind: "pull_request_ready", pr }],
      ready: [],
    });
  } finally {
    h.cleanup();
  }
});

test("signature verification rejects missing, malformed, and short headers", () => {
  const body = "{}";
  assert.equal(verifyWebhookSignature("s", body, sign(body)), true);
  assert.equal(verifyWebhookSignature("s", body, null), false);
  assert.equal(
    verifyWebhookSignature("s", body, sign(body).replace("sha256=", "sha1=")),
    false,
  );
  assert.equal(verifyWebhookSignature("s", body, "sha256=abcd"), false);
  assert.equal(verifyWebhookSignature("t", body, sign(body)), false);
});
