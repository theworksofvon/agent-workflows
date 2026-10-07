import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { world, type App, type World } from "./harness/app.js";

let w: World;
let app: App;

before(async () => {
  w = await world();
  w.github.addPull(
    {
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "Rename the widget",
      author: "octo-work",
      baseRef: "main",
      headRef: "chore/rename",
    },
    { "app.ts": 'export function main(): string {\n  return "gadget";\n}\n' },
  );
  app = await w.start();
});

after(() => w.close());

test("health names the agent", async () => {
  const { status, body } = await app.api("GET", "health");
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, agent: "claude-code" });
});

test("accounts come from gh, and the current account can change", async () => {
  const list = await app.api("GET", "accounts");
  assert.deepEqual(
    list.body.accounts.map((a: { login: string }) => a.login),
    ["octocat", "octo-work"],
  );
  assert.equal(list.body.current, "octocat");

  const changed = await app.api("PUT", "accounts/current", {
    login: "octo-work",
  });
  assert.equal(changed.status, 200);
  assert.equal((await app.api("GET", "accounts")).body.current, "octo-work");
  await app.api("PUT", "accounts/current", { login: "octocat" });
});

test("the inbox lists the PRs that GitHub returns, with their checks", async () => {
  const inbox = await app.api("GET", "inbox?refresh=1");
  assert.equal(inbox.status, 200);
  const pulls = inbox.body.pulls;
  assert.ok(pulls.length >= 1);
  assert.equal(pulls[0].title, "Rename the widget");
  assert.equal(pulls[0].checks, "passing");
  assert.equal(inbox.body.stale, false);

  const repo = await app.api("GET", "repos/acme/widgets/pulls");
  assert.deepEqual(
    repo.body.pulls.map((p: { number: number }) => p.number),
    [7],
  );

  const detail = await app.api("GET", "repos/acme/widgets/pulls/7");
  assert.equal(detail.body.pull.headRef, "chore/rename");

  const checks = await app.api("GET", "repos/acme/widgets/pulls/7/checks");
  assert.equal(checks.body.checks[0].name, "test");
  assert.equal(checks.body.checks[0].workflowName, "CI");
});

test("an unknown PR is a 404 from GitHub", async () => {
  const { status } = await app.api("GET", "repos/acme/widgets/pulls/99");
  assert.ok(status >= 400);
});

test("requests from another site or host are refused", async () => {
  const foreignHost = await raw("GET", "/api/health", { host: "evil.test" });
  assert.equal(foreignHost.status, 403);

  const foreignOrigin = await raw(
    "POST",
    "/api/sessions",
    {
      origin: "http://evil.test",
      "content-type": "application/json",
    },
    "{}",
  );
  assert.equal(foreignOrigin.status, 403);

  const form = await raw(
    "POST",
    "/api/sessions",
    {
      "content-type": "application/x-www-form-urlencoded",
    },
    "target=acme/widgets%237",
  );
  assert.equal(form.status, 415);
});

test("the app serves the web page", async () => {
  const page = await raw("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<html/i);
});

test("SIGTERM stops the app cleanly", async () => {
  const second = await w.start();
  assert.equal(await second.stop(), 0);
});

function raw(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      `${app.url}${path}`,
      { method, headers: { host: app.host, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode!, body: text }));
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
