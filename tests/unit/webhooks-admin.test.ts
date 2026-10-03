import test from "node:test";
import assert from "node:assert/strict";
import {
  WEBHOOK_PATH,
  installWebhooks,
  webhookStatus,
} from "../../src/services/webhooks-admin.js";
import { WEBHOOK_EVENTS } from "../../src/domain/webhook.js";
import type {
  HookDelivery,
  HookRecord,
} from "../../src/adapters/github/github.interface.js";
import type { Config } from "../../src/config.js";
import type { RepoRef } from "../../src/domain/events.js";

const REPOS: RepoRef[] = [
  { owner: "o", repo: "a" },
  { owner: "o", repo: "b" },
];
const TARGET = `https://box.ts.net${WEBHOOK_PATH}`;

function makeConfig(secret: string | null = "s3cret"): Config {
  return { repos: REPOS, webhookSecret: secret } as Config;
}

function fakeGithub(initial: Record<string, HookRecord[]> = {}) {
  const hooks = new Map<string, HookRecord[]>(Object.entries(initial));
  const updates: Array<{ id: number; secret: string; events: string[] }> = [];
  let nextId = 100;
  const key = (r: RepoRef) => `${r.owner}/${r.repo}`;
  const deliveries: HookDelivery[] = [
    {
      id: 1,
      event: "issue_comment",
      statusCode: 202,
      deliveredAt: "2026-10-02T00:00:00Z",
      redelivery: false,
    },
  ];
  return {
    hooks,
    updates,
    async listHooks(r: RepoRef) {
      return hooks.get(key(r)) ?? [];
    },
    async createHook(
      r: RepoRef,
      args: { url: string; secret: string; events: string[] },
    ) {
      const hook = {
        id: nextId++,
        url: args.url,
        events: args.events,
        active: true,
      };
      hooks.set(key(r), [...(hooks.get(key(r)) ?? []), hook]);
      return hook;
    },
    async updateHook(
      _repo: RepoRef,
      id: number,
      args: { url: string; secret: string; events: string[] },
    ) {
      updates.push({ id, secret: args.secret, events: args.events });
      return { id, url: args.url, events: args.events, active: true };
    },
    async listHookDeliveries() {
      return deliveries;
    },
  };
}

test("install creates hooks where absent and reports the target URL", async () => {
  const github = fakeGithub();
  const results = await installWebhooks({
    config: makeConfig(),
    github,
    publicUrl: "https://box.ts.net",
  });
  assert.deepEqual(
    results.map((r) => [r.action, r.hookId, r.url]),
    [
      ["created", 100, TARGET],
      ["created", 101, TARGET],
    ],
  );
  assert.deepEqual(github.hooks.get("o/a")?.[0].events, [...WEBHOOK_EVENTS]);
});

test("install updates a hook at the same URL and leaves other hooks alone", async () => {
  const github = fakeGithub({
    "o/a": [
      { id: 7, url: "https://other.example/hook", events: [], active: true },
      { id: 8, url: TARGET, events: ["push"], active: false },
    ],
  });
  const results = await installWebhooks({
    config: makeConfig(),
    github,
    publicUrl: "https://box.ts.net/ignored/path",
  });
  assert.deepEqual([results[0].action, results[0].hookId], ["updated", 8]);
  assert.equal(results[1].action, "created");
  assert.deepEqual(github.updates, [
    { id: 8, secret: "s3cret", events: [...WEBHOOK_EVENTS] },
  ]);
});

test("install requires a webhook secret", async () => {
  await assert.rejects(
    installWebhooks({
      config: makeConfig(null),
      github: fakeGithub(),
      publicUrl: "https://box.ts.net",
    }),
    /WEBHOOK_SECRET/,
  );
});

test("status reports a missing hook and recent deliveries", async () => {
  const github = fakeGithub({
    "o/b": [{ id: 9, url: TARGET, events: [], active: true }],
  });
  const results = await webhookStatus({
    config: makeConfig(),
    github,
    publicUrl: "https://box.ts.net",
  });
  assert.equal(results[0].hookId, null);
  assert.deepEqual(results[0].deliveries, []);
  assert.equal(results[1].hookId, 9);
  assert.equal(results[1].deliveries[0].statusCode, 202);
  assert.equal(results[1].url, TARGET);
});
