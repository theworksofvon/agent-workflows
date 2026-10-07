import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import {
  sqliteReviewSessions,
  type ReviewSessionStore,
} from "../../src/adapters/state/review-sessions.js";
import {
  BadRequestError,
  reviewApi,
  type ReviewApi,
} from "../../src/services/review-api.js";
import { sqliteSettings } from "../../src/adapters/state/settings.js";
import { githubAccess } from "../../src/services/github-access.js";
import { fakeAccounts, fakeClient } from "../fakes/github.js";
import {
  DEFAULT_STATIC_DIR,
  startReviewServer,
} from "../../src/adapters/http/review-server.js";

interface Fixture {
  url: string;
  started: string[];
  logs: string[];
  sessions: ReviewSessionStore;
}

async function withServer(
  options: {
    staticDir?: string;
    api?: (base: ReviewApi) => ReviewApi;
    host?: string;
    publicPort?: number;
  },
  run: (f: Fixture) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "review-server-"));
  const db = openStateDatabase(join(root, "state"));
  const started: string[] = [];
  const logs: string[] = [];
  const sessions = sqliteReviewSessions(db);
  const base = reviewApi({
    sessions,
    github: githubAccess({
      accounts: fakeAccounts(),
      settings: sqliteSettings(db),
      createClient: (token) => fakeClient(token, []),
    }),
    startRun: async (id) => {
      started.push(id);
    },
    agent: "codex",
  });
  const originalError = console.error;
  console.error = (line: string) => {
    logs.push(line);
  };
  const handle = await startReviewServer({
    host: options.host ?? "127.0.0.1",
    port: 0,
    publicPort: options.publicPort,
    api: options.api ? options.api(base) : base,
    staticDir: options.staticDir ?? join(root, "no-dist"),
  });
  try {
    await run({ url: handle.url, started, logs, sessions });
  } finally {
    await handle.close();
    console.error = originalError;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A built app in <root>/dist with a secret beside it that must stay unreachable. */
function makeDist(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "review-dist-"));
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
  const dir = join(root, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "app.css"), "body{}");
  writeFileSync(join(dir, "assets", "font.woff2"), "w");
  writeFileSync(join(dir, "assets", "blob.bin"), "b");
  return { root, dir };
}

const JSON_TYPE = { "content-type": "application/json" };

/**
 * Sends the path and headers exactly as written; fetch would normalize `..`
 * away and does not let a caller set Host.
 */
function raw(
  url: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    chunked?: boolean;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${url}${path}`,
      { path, method: init.method ?? "GET", headers: init.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (init.chunked) req.write(init.body ?? "");
    req.end(init.chunked ? undefined : init.body);
  });
}

test("the default static root is web/dist at the repository root", () => {
  assert.match(DEFAULT_STATIC_DIR, /[/\\]web[/\\]dist$/);
  assert.doesNotMatch(DEFAULT_STATIC_DIR, /[/\\](src|dist)[/\\]web/);
});

test("static files, SPA fallback, and traversal protection", async () => {
  const dist = makeDist();
  try {
    await withServer({ staticDir: dist.dir }, async ({ url }) => {
      const index = await fetch(`${url}/`);
      assert.equal(index.status, 200);
      assert.equal(
        index.headers.get("content-type"),
        "text/html; charset=utf-8",
      );
      assert.match(await index.text(), /<title>app<\/title>/);

      const js = await fetch(`${url}/assets/app.js?v=1`);
      assert.equal(
        js.headers.get("content-type"),
        "text/javascript; charset=utf-8",
      );
      assert.equal(await js.text(), "console.log(1)");
      const css = await fetch(`${url}/assets/app.css`);
      assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
      const font = await fetch(`${url}/assets/font.woff2`);
      assert.equal(font.headers.get("content-type"), "font/woff2");
      const bin = await fetch(`${url}/assets/blob.bin`);
      assert.equal(bin.headers.get("content-type"), "application/octet-stream");

      const deep = await fetch(`${url}/sessions/abc/chapters/core`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /<title>app<\/title>/);
      const dirPath = await fetch(`${url}/assets`);
      assert.match(await dirPath.text(), /<title>app<\/title>/);

      for (const path of [
        "/../secret.txt",
        "/assets/../../secret.txt",
        "/..%2Fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/%2e%2e/secret.txt",
        "/..%5Csecret.txt",
        "/assets%2F..%2F..%2Fsecret.txt",
        "/index.html%00.js",
        "/%E0%A4%A",
      ]) {
        const res = await raw(url, path);
        assert.equal(res.status, 404, path);
        assert.doesNotMatch(res.body, /TOP SECRET/, path);
      }
      const inside = await raw(url, "/assets/../assets/app.js");
      assert.equal(inside.body, "console.log(1)");

      const post = await fetch(`${url}/`, { method: "POST" });
      assert.equal(post.status, 404);
    });
  } finally {
    rmSync(dist.root, { recursive: true, force: true });
  }
});

test("a missing build serves a page that says how to build the app", async () => {
  await withServer({}, async ({ url }) => {
    for (const path of ["/", "/sessions/abc"]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(await res.text(), /Run <code>mise run web:build<\/code>/);
    }
  });
});

test("the API creates, lists, and gets a session and maps errors to JSON", async () => {
  await withServer({}, async ({ url, started, sessions }) => {
    const health = await fetch(`${url}/api/health`);
    assert.deepEqual(await health.json(), { ok: true, agent: "codex" });

    const created = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "acme/widgets#7" }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    assert.deepEqual(started, [id]);

    const listed = (await (await fetch(`${url}/api/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    assert.deepEqual(
      listed.sessions.map((s) => s.id),
      [id],
    );

    const got = await fetch(`${url}/api/sessions/${id}`);
    assert.equal(got.status, 200);
    const detail = (await got.json()) as {
      session: { id: string; prNumber: number };
      findings: unknown[];
    };
    assert.equal(detail.session.prNumber, 7);
    assert.deepEqual(detail.findings, []);

    const early = await fetch(`${url}/api/sessions/${id}/rerun`, {
      method: "POST",
    });
    assert.equal(early.status, 409);
    sessions.update(id, { status: "failed" });
    const rerun = await fetch(`${url}/api/sessions/${id}/rerun`, {
      method: "POST",
    });
    assert.equal(rerun.status, 201);
    assert.equal(started.length, 2);

    // A session stored without an account gets one chosen, once.
    sessions.update(id, { account: "" });
    const choose = (login: string) =>
      fetch(`${url}/api/sessions/${id}/account`, {
        method: "PUT",
        headers: JSON_TYPE,
        body: JSON.stringify({ login }),
      });
    const blocked = await fetch(`${url}/api/sessions/${id}/rerun`, {
      method: "POST",
    });
    assert.equal(blocked.status, 409);
    assert.match(
      ((await blocked.json()) as { error: string }).error,
      /choose the account for this review/,
    );
    const chosen = await fetch(`${url}/api/sessions/${id}/rerun`, {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ account: "alice" }),
    });
    assert.equal(chosen.status, 201);
    assert.deepEqual(await (await choose("alice")).json(), {
      account: "alice",
    });
    assert.equal((await choose("bob")).status, 409);

    const chapter = await fetch(
      `${url}/api/sessions/${id}/chapters/core%20one`,
      {
        method: "PUT",
        headers: JSON_TYPE,
        body: JSON.stringify({ reviewed: true }),
      },
    );
    assert.deepEqual(
      ((await chapter.json()) as { human: { chapters: object } }).human
        .chapters,
      { "core one": true },
    );
    const file = await fetch(`${url}/api/sessions/${id}/files`, {
      method: "PUT",
      headers: JSON_TYPE,
      body: JSON.stringify({ path: "src/a.ts", viewed: true }),
    });
    assert.equal(file.status, 200);

    const cases: Array<[string, RequestInit, number, RegExp]> = [
      ["/api/sessions/missing", {}, 404, /not found/],
      ["/api/nope", {}, 404, /not found/],
      ["/api/sessions/x/unknown", {}, 404, /not found/],
      ["/api/sessions", { method: "DELETE" }, 404, /not found/],
      [
        "/api/sessions",
        { method: "POST", body: JSON.stringify({ target: "bad" }) },
        400,
        /Invalid PR target/,
      ],
      ["/api/sessions", { method: "POST", body: "{not json" }, 400, /JSON/],
      [`/api/sessions/${id}/publish`, {}, 409, /not ready/],
      [
        `/api/sessions/${id}/publish`,
        { method: "POST", body: JSON.stringify({ event: "COMMENT" }) },
        400,
        /confirm/,
      ],
      [`/api/sessions/${id}/discuss`, {}, 409, /no pull request/],
      [
        `/api/sessions/${id}/findings/abc`,
        { method: "PUT", body: JSON.stringify({ verdict: "agree" }) },
        404,
        /finding/,
      ],
      [
        `/api/sessions/${id}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ path: "a", line: 1, body: "x" }),
        },
        400,
        /not a file/,
      ],
      [`/api/sessions/${id}/comments/c1`, { method: "DELETE" }, 404, /comment/],
      ["/api/repos/acme/widgets/pulls", {}, 200, /"pulls":\[\]/],
      ["/api/repos/acme/bad%20name/pulls", {}, 400, /repository/],
      ["/api/repos/acme/widgets/pulls/7", {}, 200, /"body":"Adds widgets\."/],
      ["/api/repos/acme/widgets/pulls/x", {}, 400, /number/],
      [
        "/api/repos/acme/widgets/pulls/7/checks",
        {},
        200,
        /"rollup":null,"checks":\[\],"headSha":"abc123"/,
      ],
      [`/api/sessions/${id}/checks`, {}, 200, /"headSha":"abc123"/],
      ["/api/sessions/missing/checks", {}, 404, /not found/],
      ["/api/accounts", {}, 200, /"current":"alice"/],
      [
        "/api/inbox",
        {},
        200,
        /"account":"alice","viewer":"alice","pulls":\[\]/,
      ],
      ["/api/inbox?refresh=1", {}, 200, /"pulls":\[\]/],
      [
        "/api/accounts/current",
        { method: "PUT", body: JSON.stringify({ login: "mallory" }) },
        400,
        /unknown GitHub account: mallory/,
      ],
      [
        "/api/accounts/current",
        { method: "PUT", body: JSON.stringify({ login: "bob" }) },
        200,
        /"current":"bob"/,
      ],
      ["/api/accounts", {}, 200, /"current":"bob"/],
      ["/api/sessions/%E0%A4%A", {}, 400, /path/],
    ];
    for (const [path, init, status, body] of cases) {
      const res = await fetch(`${url}${path}`, { headers: JSON_TYPE, ...init });
      assert.equal(res.status, status, path);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.match(await res.text(), body, path);
    }
  });
});

test("an oversized body is refused and an unexpected failure is a logged 500", async () => {
  await withServer(
    {
      api: (base) => ({
        ...base,
        health: () => {
          throw new Error("disk on fire");
        },
        listSessions: () => {
          throw "not an error";
        },
        createSession: () => {
          throw new BadRequestError("never reached");
        },
      }),
    },
    async ({ url, logs }) => {
      const broken = await fetch(`${url}/api/health`);
      assert.equal(broken.status, 500);
      assert.deepEqual(await broken.json(), { error: "disk on fire" });
      const thrown = await fetch(`${url}/api/sessions`);
      assert.equal(thrown.status, 500);
      assert.deepEqual(await thrown.json(), { error: "not an error" });
      assert.equal(logs.length, 2);
      assert.match(logs[0], /\[ERROR\] review api request failed/);
      assert.match(logs[0], /disk on fire/);

      const big = await fetch(`${url}/api/sessions`, {
        method: "POST",
        headers: JSON_TYPE,
        body: "x".repeat(1024 * 1024 + 1),
      });
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "payload too large" });
    },
  );
});

test("requests for another Host are refused, which stops DNS rebinding", async () => {
  await withServer({}, async ({ url }) => {
    const port = new URL(url).port;
    for (const host of [`evil.example:${port}`, "127.0.0.1:1", "localhost"]) {
      const res = await raw(url, "/api/sessions", { headers: { host } });
      assert.equal(res.status, 403, host);
      assert.deepEqual(JSON.parse(res.body), { error: "host not allowed" });
    }
    const page = await raw(url, "/", { headers: { host: "evil.example" } });
    assert.equal(page.status, 403);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const res = await raw(url, "/api/health", { headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });
});

test("a published port is accepted for loopback names only, as when Docker maps a host port", async () => {
  await withServer({ host: "0.0.0.0", publicPort: 4793 }, async ({ url }) => {
    const port = new URL(url).port;
    const local = url.replace("0.0.0.0", "127.0.0.1");
    for (const host of [
      "127.0.0.1:4793",
      "localhost:4793",
      `localhost:${port}`,
    ]) {
      const res = await raw(local, "/api/health", { headers: { host } });
      assert.equal(res.status, 200, host);
    }
    for (const host of ["evil.example:4793", "127.0.0.1:4794", "localhost"]) {
      const res = await raw(local, "/api/health", { headers: { host } });
      assert.equal(res.status, 403, host);
    }
    const write = (origin: string) =>
      raw(local, "/api/sessions", {
        method: "POST",
        headers: { ...JSON_TYPE, host: "127.0.0.1:4793", origin },
        body: JSON.stringify({ target: "acme/widgets#7" }),
      });
    assert.equal((await write("http://localhost:4793")).status, 201);
    assert.equal((await write("http://evil.example:4793")).status, 403);
  });
});

test("a write from another Origin is refused before it reaches the API", async () => {
  await withServer({}, async ({ url, started }) => {
    const body = JSON.stringify({ target: "acme/widgets#7" });
    for (const origin of [
      "https://evil.example",
      "http://127.0.0.1:1",
      "null",
    ]) {
      const res = await fetch(`${url}/api/sessions`, {
        method: "POST",
        headers: { ...JSON_TYPE, origin },
        body,
      });
      assert.equal(res.status, 403, origin);
      assert.deepEqual(await res.json(), { error: "origin not allowed" });
    }
    const bodyless = await fetch(`${url}/api/sessions/x/rerun`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(bodyless.status, 403);
    const switched = await fetch(`${url}/api/accounts/current`, {
      method: "PUT",
      headers: { ...JSON_TYPE, origin: "https://evil.example" },
      body: JSON.stringify({ login: "bob" }),
    });
    assert.equal(switched.status, 403);
    const accounts = await fetch(`${url}/api/accounts`);
    assert.equal(
      ((await accounts.json()) as { current: string }).current,
      "alice",
    );
    assert.deepEqual(started, []);
  });
});

test("a write with a body that is not JSON is refused with 415", async () => {
  await withServer({}, async ({ url, started }) => {
    const body = JSON.stringify({ target: "acme/widgets#7" });
    const plain = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    assert.equal(plain.status, 415);
    assert.deepEqual(await plain.json(), {
      error: "content-type must be application/json",
    });
    const untyped = await raw(url, "/api/sessions", {
      method: "POST",
      body,
      chunked: true,
    });
    assert.equal(untyped.status, 415);
    assert.deepEqual(started, []);
  });
});

test("a same-origin JSON write and a bodyless write without content-type still work", async () => {
  await withServer({}, async ({ url, started, sessions }) => {
    const created = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: url,
      },
      body: JSON.stringify({ target: "acme/widgets#7" }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    sessions.update(id, { status: "ready" });
    const rerun = await fetch(`${url}/api/sessions/${id}/rerun`, {
      method: "POST",
      headers: { origin: url },
    });
    assert.equal(rerun.status, 201);
    const localhost = url.replace("127.0.0.1", "localhost");
    const viaName = await raw(url, `/api/sessions/${id}/rerun`, {
      method: "POST",
      headers: { host: new URL(localhost).host, origin: localhost },
    });
    assert.equal(viaName.status, 201);
    assert.equal(started.length, 3);
  });
});
