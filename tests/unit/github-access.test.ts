import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKS_CACHE_MS,
  CURRENT_ACCOUNT_KEY,
  githubAccess,
  INBOX_CACHE_MS,
  RATE_LIMIT_BACKOFF_MS,
  type AccountClient,
} from "../../src/services/github-access.js";
import { RateLimitedError } from "../../src/domain/errors.js";
import { UnknownAccountError } from "../../src/adapters/github/accounts.js";
import type { Check } from "../../src/domain/inbox.js";
import { fakeAccounts, fakeClient, memorySettings } from "../fakes/github.js";

const repo = { owner: "acme", repo: "widgets" };

function harness(client: Partial<AccountClient> = {}) {
  const calls: unknown[][] = [];
  const created: string[] = [];
  const settings = memorySettings();
  let ms = Date.UTC(2026, 9, 7);
  const access = githubAccess({
    accounts: fakeAccounts(),
    settings,
    createClient: (token) => {
      created.push(token);
      return fakeClient(token, calls, client);
    },
    now: () => new Date(ms),
  });
  return {
    access,
    calls,
    created,
    settings,
    advance: (by: number) => {
      ms += by;
    },
  };
}

test("the current account is the stored one while gh still lists it, else gh's active one", async () => {
  const h = harness();
  assert.equal(await h.access.current(), "alice");
  assert.equal(await h.access.setCurrent("bob"), "bob");
  assert.equal(h.settings.get(CURRENT_ACCOUNT_KEY), "bob");
  assert.equal(await h.access.current(), "bob");
  h.settings.set(CURRENT_ACCOUNT_KEY, "logged-out");
  assert.equal(await h.access.current(), "alice");
  await assert.rejects(h.access.setCurrent("mallory"), UnknownAccountError);
  assert.equal(await h.access.resolve(""), "alice");
  assert.equal(await h.access.resolve("bob"), "bob");
});

test("each account gets its own client, built once per token", async () => {
  const h = harness();
  const alice = await h.access.use("alice");
  const again = await h.access.use("");
  const bob = await h.access.use("bob");
  assert.equal(alice.token, "token:alice");
  assert.equal(again.client, alice.client);
  assert.equal(bob.login, "bob");
  assert.deepEqual(h.created, ["token:alice", "token:bob"]);
  await assert.rejects(h.access.use("mallory"), UnknownAccountError);
});

test("the inbox runs one search per group and is cached per account for 60 s", async () => {
  const h = harness();
  const first = await h.access.inbox("alice", false);
  assert.deepEqual(
    h.calls.map((c) => [c[0], c[1], c[3]]),
    [
      ["search", "token:alice", 50],
      ["search", "token:alice", 50],
      ["search", "token:alice", 50],
    ],
  );
  assert.equal(first.fetchedAt, "2026-10-07T00:00:00.000Z");
  assert.equal(await h.access.inbox("alice", false), first);
  await h.access.inbox("bob", false);
  assert.equal(h.calls.length, 6);
  await h.access.inbox("alice", true);
  assert.equal(h.calls.length, 9);
  h.advance(INBOX_CACHE_MS);
  const later = await h.access.inbox("alice", false);
  assert.equal(h.calls.length, 12);
  assert.equal(later.fetchedAt, "2026-10-07T00:01:00.000Z");
});

test("checks are deduped, rolled up, and cached for 20 s per account and PR", async () => {
  const run = (overrides: Partial<Check>): Check => ({
    name: "test",
    workflowName: "CI",
    status: "failure",
    url: null,
    startedAt: null,
    completedAt: "2026-10-07T00:01:00Z",
    ...overrides,
  });
  const h = harness({
    async getPullRequestChecks(ref, n) {
      h.calls.push(["checks", ref, n]);
      return {
        headSha: "abc123",
        checks: [
          run({}),
          run({ status: "success", completedAt: "2026-10-07T00:02:00Z" }),
          run({ name: "lint", status: "pending" }),
        ],
        truncated: false,
        overall: null,
      };
    },
  });
  const checks = await h.access.checks("alice", repo, 7);
  assert.equal(checks.rollup, "pending");
  assert.deepEqual(
    checks.checks.map((c) => [c.name, c.status]),
    [
      ["test", "success"],
      ["lint", "pending"],
    ],
  );
  assert.equal(checks.headSha, "abc123");
  assert.equal(await h.access.checks("alice", repo, 7), checks);
  await h.access.checks("alice", repo, 8);
  await h.access.checks("bob", repo, 7);
  assert.equal(h.calls.length, 3);
  h.advance(CHECKS_CACHE_MS);
  await h.access.checks("alice", repo, 7);
  assert.equal(h.calls.length, 4);
});

test("the inbox reports truncated groups and deduped warnings", async () => {
  const h = harness({
    async searchPullRequests(query) {
      const involved = query.includes("involves:@me");
      return {
        pulls: [],
        truncated: involved,
        warnings: involved ? [] : ["SAML enforcement on acme"],
      };
    },
  });
  const inbox = await h.access.inbox("alice", false);
  assert.deepEqual(inbox.truncated, {
    reviewRequested: false,
    authored: false,
    involved: true,
  });
  assert.deepEqual(inbox.warnings, ["SAML enforcement on acme"]);
  assert.equal(inbox.stale, false);
});

test("a rate limit serves the last inbox as stale and holds refreshes for 60 s", async () => {
  let limited = false;
  let searches = 0;
  const h = harness({
    async searchPullRequests() {
      searches += 1;
      if (limited) throw new RateLimitedError("API rate limit exceeded");
      return { pulls: [], truncated: false, warnings: [] };
    },
  });
  const fresh = await h.access.inbox("alice", false);
  h.advance(INBOX_CACHE_MS / 2);
  limited = true;
  const stale = await h.access.inbox("alice", true);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  const tried = searches;

  // Within the backoff a refresh reads the cache, then the last inbox.
  assert.equal(await h.access.inbox("alice", true), fresh);
  h.advance(INBOX_CACHE_MS / 2);
  assert.equal((await h.access.inbox("alice", true)).stale, true);
  assert.equal(searches, tried);

  // After the backoff the next request asks GitHub again.
  h.advance(RATE_LIMIT_BACKOFF_MS);
  limited = false;
  const again = await h.access.inbox("alice", true);
  assert.equal(again.stale, false);
  assert.ok(searches > tried);

  // Without an earlier inbox the rate limit is the error.
  limited = true;
  await assert.rejects(h.access.inbox("bob", false), RateLimitedError);
  await assert.rejects(h.access.inbox("bob", false), RateLimitedError);
});

test("an inbox failure that is not a rate limit is the error", async () => {
  const h = harness({
    async searchPullRequests() {
      throw new Error("offline");
    },
  });
  await assert.rejects(h.access.inbox("alice", false), /offline/);
});

test("truncated checks count GitHub's own rollup of the unread contexts", async () => {
  const pass: Check = {
    name: "ok",
    workflowName: null,
    status: "success",
    url: null,
    startedAt: null,
    completedAt: null,
  };
  let live: { truncated: boolean; overall: Check["status"] | null } = {
    truncated: true,
    overall: "failure",
  };
  const h = harness({
    async getPullRequestChecks() {
      return {
        headSha: "abc123",
        checks: [pass],
        truncated: live.truncated,
        overall: live.overall,
      };
    },
  });
  const truncated = await h.access.checks("alice", repo, 1);
  assert.equal(truncated.rollup, "failing");
  assert.equal(truncated.truncated, true);
  live = { truncated: true, overall: null };
  assert.equal((await h.access.checks("alice", repo, 2)).rollup, "passing");
  live = { truncated: false, overall: "failure" };
  const whole = await h.access.checks("alice", repo, 3);
  assert.equal(whole.rollup, "passing");
  assert.equal(whole.truncated, false);
});
