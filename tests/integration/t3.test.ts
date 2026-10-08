import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FAKE_T3_ENVIRONMENT } from "./harness/fake-t3.js";
import { world, type App, type World } from "./harness/app.js";

let w: World;
let app: App;

const GREET =
  "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n";

before(async () => {
  w = await world();
  for (const [repo, number] of [
    ["widgets", 1],
    ["gadgets", 4],
  ] as const)
    w.github.addPull(
      {
        owner: "acme",
        repo,
        number,
        title: "Add greet",
        author: "octo-work",
        baseRef: "main",
        headRef: "feat/greet",
      },
      { "greet.ts": GREET },
    );
  w.t3.projects.push(
    { id: "proj-other", repositoryIdentity: null },
    {
      id: "proj-widgets",
      repositoryIdentity: {
        provider: "github",
        owner: "ACME",
        name: "Widgets",
      },
    },
  );
  app = await w.start();
});

after(() => w.close());

test("before a sign-in, T3 calls ask the reviewer to connect", async () => {
  const status = await app.api("GET", "t3");
  assert.deepEqual(status.body, {
    connected: false,
    mcpUrl: w.t3.mcpUrl,
    expiresAt: null,
  });
  const id = await reviewOf("acme/widgets#1");
  const open = await app.api("POST", `sessions/${id}/t3`);
  assert.equal(open.status, 409);
  assert.match(open.body.error, /Connect T3/);
});

test("connect signs in with OAuth, and disconnect forgets the token", async () => {
  assert.equal(await connect(), "/?t3=connected#/");
  const status = (await app.api("GET", "t3")).body;
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes("t3tok"), false);
  assert.equal((await app.api("DELETE", "t3")).body.connected, false);

  const stale = await fetch(`${app.url}/api/t3/callback?code=x&state=nope`, {
    redirect: "manual",
  });
  assert.match(stale.headers.get("location")!, /t3=failed.*expired/);
  const bad = await app.api("POST", "t3/connect", { mcpUrl: "ftp://x" });
  assert.equal(bad.status, 400);
});

test("a review opens 1 thread for each account and PR", async () => {
  await connect();
  const a = await reviewOf("acme/widgets#1");
  const first = (await app.api("POST", `sessions/${a}/t3`)).body.thread;
  assert.equal(first.created, true);
  assert.equal(first.title, "Review: acme/widgets#1 as octocat");
  assert.equal(
    first.url,
    `${new URL(w.t3.mcpUrl).origin}/${FAKE_T3_ENVIRONMENT}/${first.id}`,
  );
  const launch = lastCall("t3_thread_launch");
  assert.equal(launch.args.projectId, "proj-widgets");
  assert.deepEqual(launch.args.workspaceStrategy, { type: "root" });
  assert.match(String(launch.args.message), /as the GitHub account octocat/);
  assert.match(String(launch.args.message), /preview_open/);

  const again = (await app.api("POST", `sessions/${a}/t3`)).body.thread;
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  assert.equal(count("t3_thread_launch"), 1);

  const work = await reviewOf("acme/widgets#1", "octo-work");
  const third = (await app.api("POST", `sessions/${work}/t3`)).body.thread;
  assert.notEqual(third.id, first.id);
  assert.equal(third.title, "Review: acme/widgets#1 as octo-work");

  const gadget = await reviewOf("acme/gadgets#4");
  await app.api("POST", `sessions/${gadget}/t3`);
  assert.equal(lastCall("t3_thread_launch").args.scratch, true);

  w.t3.deleteThread(first.id);
  const replaced = (await app.api("POST", `sessions/${a}/t3`)).body.thread;
  assert.notEqual(replaced.id, first.id);
  assert.equal(replaced.created, true);
});

test("a rerun tells the existing thread about the new session", async () => {
  const a = await reviewOf("acme/widgets#1");
  const opened = (await app.api("POST", `sessions/${a}/t3`)).body.thread;
  const rerun = (await app.api("POST", `sessions/${a}/rerun`, {})).body.id;
  await app.settle(rerun);
  const sends = count("t3_thread_send");
  const again = (await app.api("POST", `sessions/${rerun}/t3`)).body.thread;
  assert.equal(again.id, opened.id);
  assert.equal(count("t3_thread_send"), sends + 1);
  assert.match(
    String(lastCall("t3_thread_send").args.message),
    new RegExp(rerun),
  );
});

test("a thread lost from the table is found again by its title", async () => {
  const a = await reviewOf("acme/widgets#1", "octo-work");
  const opened = (await app.api("POST", `sessions/${a}/t3`)).body.thread;
  // A new app on a new database has no row, but T3 still has the thread.
  const fresh = await w.start({ STATE_DIR: `${w.root}/state-2` });
  await connect(fresh);
  const { body } = await fresh.api("POST", "sessions", {
    target: "acme/widgets#1",
    account: "octo-work",
  });
  await fresh.settle(body.id);
  const found = (await fresh.api("POST", `sessions/${body.id}/t3`)).body.thread;
  assert.equal(found.id, opened.id);
  assert.equal(found.created, false);
  await fresh.stop();
});

test("Ask sends 1 message with the lines, the account, and the request id", async () => {
  const id = await reviewOf("acme/widgets#1");
  const res = await app.api("POST", `sessions/${id}/ask`, {
    text: "Is this safe?",
    path: "greet.ts",
    lines: { start: 1, end: 2 },
    finding: "f1",
    requestId: "r1",
  });
  assert.equal(res.status, 200);
  const sent = lastCall("t3_thread_send");
  assert.equal(
    sent.args.message,
    `About greet.ts:1–2 (finding f1, review ${id}, as octocat):\nIs this safe?`,
  );
  assert.equal(sent.args.clientRequestId, "ask-r1");
  assert.equal(
    (await app.api("POST", `sessions/${id}/ask`, { text: " " })).status,
    400,
  );
});

test("open starts a review and prints its thread", async () => {
  await connect();
  const env = { UI_PORT: String(app.port) };
  const r = await w.cli(["open", "acme/widgets#1"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Opened in T3: Review: acme\/widgets#1 as octocat/);

  const usage = await w.cli(["open"], env);
  assert.equal(usage.status, 1);
  assert.match(usage.stdout + usage.stderr, /Usage: pnpm agent-workflows open/);
  const down = await w.cli(["open", "acme/widgets#1"], { UI_PORT: "1" });
  assert.match(down.stdout + down.stderr, /not running/);
  const silent = await w.cli(["open", "acme/widgets#2"], env);
  assert.match(silent.stdout + silent.stderr, /not found|failed/i);
});

test("a token that T3 refuses disconnects the app", async () => {
  const id = await reviewOf("acme/widgets#1");
  w.t3.revokeTokens();
  const res = await app.api("POST", `sessions/${id}/t3`);
  assert.equal(res.status, 409);
  assert.equal((await app.api("GET", "t3")).body.connected, false);
});

test("a T3 that does not answer is a 502 with its URL", async () => {
  const down = await w.start({ STATE_DIR: `${w.root}/state-3` });
  await connect(down);
  const { body } = await down.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  await down.settle(body.id);
  await w.t3.close();
  const res = await down.api("POST", `sessions/${body.id}/t3`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /not reachable/);
  await down.stop();
});

/** Runs the sign-in as the browser would; returns where the app sends it. */
async function connect(target: App = app): Promise<string> {
  const { body } = await target.api("POST", "t3/connect", {});
  const approved = await fetch(body.authorizeUrl, { redirect: "manual" });
  const back = await fetch(approved.headers.get("location")!, {
    redirect: "manual",
  });
  return back.headers.get("location")!;
}

async function reviewOf(target: string, account?: string): Promise<string> {
  const { body } = await app.api("POST", "sessions", { target, account });
  await app.settle(body.id);
  return body.id;
}

function lastCall(tool: string) {
  return w.t3.calls.filter((c) => c.tool === tool).at(-1)!;
}

function count(tool: string): number {
  return w.t3.calls.filter((c) => c.tool === tool).length;
}
