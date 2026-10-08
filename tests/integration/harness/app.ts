import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.js";
import { startFakeT3, type FakeT3 } from "./fake-t3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN = join(REPO_ROOT, "src", "main.ts");
const TSX = pathToFileURL(
  join(REPO_ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;
const BIN = join(HERE, "bin");

/**
 * A temporary world for the app: a HOME whose git config sends github.com
 * to the fake's bare repositories, the fake gh and agent on PATH, and an
 * empty working directory, so no .env from this checkout is read.
 */
export interface World {
  root: string;
  github: FakeGitHub;
  t3: FakeT3;
  env: Record<string, string>;
  /** Runs `main.ts` with `args` to completion. */
  cli(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** Starts `main.ts start` and waits until it serves. */
  start(env?: Record<string, string>): Promise<App>;
  close(): Promise<void>;
}

/**
 * The tests read the API's JSON by field, as the web app does; asserting a
 * wrong field fails the test, so the shapes stay untyped here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface App {
  url: string;
  host: string;
  port: number;
  /** Sends a request as the app's own page would. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }>;
  /** Polls a session until it is ready or failed. */
  settle(id: string): Promise<Json>;
  /** Calls a tool on the app's MCP endpoint, as an agent would. */
  mcp(tool: string, args: object): Promise<{ isError: boolean; data: Json }>;
  mcpTools(): Promise<string[]>;
  /** Opens the session's event stream; `next` resolves with each event name. */
  events(id: string): EventStream;
  stop(): Promise<number | null>;
}

export interface EventStream {
  next(): Promise<string>;
  close(): void;
}

export async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-it-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  const github = await startFakeGitHub(root);
  const t3 = await startFakeT3();
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${github.remotes}/"]\n\tinsteadOf = https://github.com/\n`,
  );
  const env: Record<string, string> = {
    PATH: `${BIN}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    STATE_DIR: join(root, "state"),
    GITHUB_API_URL: github.url,
    AGENT: "claude-code",
    CLAUDE_CODE_BIN: join(BIN, "agent"),
    FAKE_GH_ACCOUNTS: "octocat,octo-work",
    LOG_LEVEL: "error",
    T3_MCP_URL: t3.mcpUrl,
  };
  // Child processes write their coverage here for the test runner.
  if (process.env.NODE_V8_COVERAGE)
    env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;

  const argv = (args: string[]) => ["--import", TSX, MAIN, ...args];
  const apps: App[] = [];

  return {
    root,
    github,
    t3,
    env,
    // Async: the fake GitHub in this process must keep answering.
    cli: (args, extra = {}) =>
      new Promise((done) => {
        const child = spawn(process.execPath, argv(args), {
          cwd,
          env: { ...env, ...extra },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => done({ status, stdout, stderr }));
      }),
    start: async (extra = {}) => {
      const port = await freePort();
      const child = spawn(process.execPath, argv(["start"]), {
        cwd,
        env: { ...env, UI_PORT: String(port), ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const app = await serving(child, port);
      apps.push(app);
      return app;
    },
    close: async () => {
      await Promise.all(apps.map((app) => app.stop()));
      await github.close();
      await t3.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function serving(child: ChildProcess, port: number): Promise<App> {
  const host = `127.0.0.1:${port}`;
  const url = `http://${host}`;
  const exited = new Promise<number | null>((done) =>
    child.on("exit", (code) => done(code)),
  );
  const app: App = {
    url,
    host,
    port,
    api: async (method, path, body) => {
      const res = await fetch(`${url}/api/${path}`, {
        method,
        headers: {
          origin: url,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    settle: async (id) => {
      for (let i = 0; i < 300; i++) {
        const { body } = await app.api("GET", `sessions/${id}`);
        if (["ready", "failed"].includes(body.session.status)) return body;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`session ${id} did not settle`);
    },
    mcp: (tool, args) =>
      withMcp(url, async (client) => {
        const res = await client.callTool({
          name: tool,
          arguments: { ...args },
        });
        const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
        return {
          isError: res.isError === true,
          data: res.structuredContent ?? text,
        };
      }),
    mcpTools: () =>
      withMcp(url, async (client) =>
        (await client.listTools()).tools.map((t) => t.name),
      ),
    events: (id) => eventStream(`${url}/api/sessions/${id}/events`),
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
  return new Promise((done, fail) => {
    let output = "";
    const watch = (chunk: Buffer) => {
      output += chunk;
      if (output.includes(`Guided review: ${url}`)) done(app);
    };
    child.stdout!.on("data", watch);
    child.stderr!.on("data", watch);
    void exited.then((code) =>
      fail(new Error(`app exited with ${code} before serving:\n${output}`)),
    );
  });
}

async function withMcp<T>(
  url: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`)),
  );
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

function eventStream(url: string): EventStream {
  const abort = new AbortController();
  const names: string[] = [];
  const waiting: Array<(name: string) => void> = [];
  void fetch(url, { signal: abort.signal })
    .then(async (res) => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const name = /^event: (.+)$/m.exec(buffer.slice(0, end))?.[1];
          buffer = buffer.slice(end + 2);
          if (!name) continue;
          const take = waiting.shift();
          if (take) take(name);
          else names.push(name);
        }
      }
    })
    .catch(() => {});
  return {
    next: () =>
      names.length > 0
        ? Promise.resolve(names.shift()!)
        : new Promise((done) => waiting.push(done)),
    close: () => abort.abort(),
  };
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}
