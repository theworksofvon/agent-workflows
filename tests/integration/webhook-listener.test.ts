import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import type { RawDelivery } from "../../src/domain/events.js";
import { startWebhookListener } from "../../src/adapters/http/listener.js";

async function withListener(
  onDelivery: (d: RawDelivery) => Promise<{ status: number; reason: string }>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const handle = await startWebhookListener({
    host: "127.0.0.1",
    port: 0,
    onDelivery,
  });
  try {
    await run(handle.url);
  } finally {
    await handle.close();
  }
}

test("a GitHub delivery reaches the handler verbatim and its result is the response", async () => {
  const received: RawDelivery[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => {
    warnings.push(line);
  };
  const body = '{"text":"héllo ✓"}';
  try {
    await withListener(
      async (d) => {
        received.push(d);
        return { status: 401, reason: "bad-signature" };
      },
      async (url) => {
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
        const res = await fetch(`${url}/webhooks/github`, {
          method: "POST",
          headers: {
            "x-github-delivery": "d-1",
            "x-github-event": "pull_request",
            "x-hub-signature-256": "sha256=abc",
          },
          body,
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { reason: "bad-signature" });
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[WARN\] webhook delivery not accepted/);
  for (const field of [
    '"id":"d-1"',
    '"event":"pull_request"',
    '"status":401',
    '"reason":"bad-signature"',
  ])
    assert.ok(warnings[0].includes(field), field);
  assert.ok(!warnings[0].includes("héllo"));
  assert.deepEqual(received, [
    {
      id: "d-1",
      event: "pull_request",
      signature256: "sha256=abc",
      body,
    },
  ]);
});

test("missing GitHub headers become empty strings and a null signature", async () => {
  const received: RawDelivery[] = [];
  await withListener(
    async (d) => {
      received.push(d);
      return { status: 202, reason: "accepted" };
    },
    async (url) => {
      const res = await fetch(`${url}/webhooks/github`, {
        method: "POST",
        body: "",
      });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { reason: "accepted" });
    },
  );
  assert.deepEqual(received, [
    { id: "", event: "", signature256: null, body: "" },
  ]);
});

test("repeated GitHub headers use the first value", async () => {
  const received: RawDelivery[] = [];
  await withListener(
    async (d) => {
      received.push(d);
      return { status: 202, reason: "accepted" };
    },
    async (url) => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${url}/webhooks/github`, {
          method: "POST",
          headers: [
            "x-github-delivery",
            "first",
            "x-github-delivery",
            "second",
            "host",
            "127.0.0.1",
            "content-length",
            "2",
          ] as unknown as Record<string, string>,
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end("{}");
      });
      assert.equal(status, 202);
    },
  );
  assert.equal(received[0].id, "first");
});

test("healthz answers ok and unknown routes are 404", async () => {
  await withListener(
    async () => ({ status: 202, reason: "accepted" }),
    async (url) => {
      const health = await fetch(`${url}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
      for (const [method, path] of [
        ["GET", "/nope"],
        ["GET", "/webhooks/github"],
        ["POST", "/healthz"],
      ]) {
        const res = await fetch(`${url}${path}`, { method });
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.deepEqual(await res.json(), { reason: "not-found" });
      }
    },
  );
});

test("a body over 1 MiB is rejected with 413 without reaching the handler", async () => {
  let calls = 0;
  await withListener(
    async () => {
      calls += 1;
      return { status: 202, reason: "accepted" };
    },
    async (url) => {
      const res = await fetch(`${url}/webhooks/github`, {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      });
      assert.equal(res.status, 413);
      assert.deepEqual(await res.json(), { reason: "payload-too-large" });
      const health = await fetch(`${url}/healthz`);
      assert.equal(health.status, 200);
    },
  );
  assert.equal(calls, 0);
});

test("a body of exactly 1 MiB is accepted", async () => {
  let size = 0;
  await withListener(
    async (d) => {
      size = d.body.length;
      return { status: 202, reason: "accepted" };
    },
    async (url) => {
      const res = await fetch(`${url}/webhooks/github`, {
        method: "POST",
        body: "x".repeat(1024 * 1024),
      });
      assert.equal(res.status, 202);
    },
  );
  assert.equal(size, 1024 * 1024);
});

test("a handler that throws yields 500 and the listener keeps serving", async () => {
  let calls = 0;
  await withListener(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { status: 202, reason: "accepted" };
    },
    async (url) => {
      const failed = await fetch(`${url}/webhooks/github`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(failed.status, 500);
      assert.deepEqual(await failed.json(), { reason: "internal-error" });
      const next = await fetch(`${url}/webhooks/github`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(next.status, 202);
    },
  );
});

test("starting on a port already in use rejects", async () => {
  const first = await startWebhookListener({
    host: "127.0.0.1",
    port: 0,
    onDelivery: async () => ({ status: 202, reason: "accepted" }),
  });
  try {
    const port = Number(new URL(first.url).port);
    await assert.rejects(
      startWebhookListener({
        host: "127.0.0.1",
        port,
        onDelivery: async () => ({ status: 202, reason: "accepted" }),
      }),
      /EADDRINUSE/,
    );
  } finally {
    await first.close();
  }
});

function rawExchange(url: string, payload: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.write(payload);
  });
}

test("a request target that is not a parseable URL is a 404, not a crash", async () => {
  await withListener(
    async () => ({ status: 202, reason: "accepted" }),
    async (url) => {
      for (const target of ["//[", "//a:b"]) {
        const reply = await rawExchange(
          url,
          `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`,
        );
        assert.match(reply, /^HTTP\/1\.1 404 /, target);
      }
      const health = await fetch(`${url}/healthz`);
      assert.equal(health.status, 200);
    },
  );
});

test("the query string does not change routing", async () => {
  await withListener(
    async () => ({ status: 202, reason: "accepted" }),
    async (url) => {
      const health = await fetch(`${url}/healthz?probe=1`);
      assert.equal(health.status, 200);
    },
  );
});

test("close does not wait on an unfinished request", async () => {
  const handle = await startWebhookListener({
    host: "127.0.0.1",
    port: 0,
    onDelivery: async () => ({ status: 202, reason: "accepted" }),
  });
  const { hostname, port } = new URL(handle.url);
  const socket = connect(Number(port), hostname);
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    "POST /webhooks/github HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    handle.close().then(() => "closed"),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timed out"), 1000);
    }),
  ]);
  clearTimeout(timer);
  socket.destroy();
  assert.equal(outcome, "closed");
});
