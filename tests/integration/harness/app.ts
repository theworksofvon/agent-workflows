import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.js";

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
  /** Sends a request as the app's own page would. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }>;
  /** Polls a session until it is ready or failed. */
  settle(id: string): Promise<Json>;
  stop(): Promise<number | null>;
}

export async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-it-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  const github = await startFakeGitHub(root);
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
  };
  // Child processes write their coverage here for the test runner.
  if (process.env.NODE_V8_COVERAGE)
    env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;

  const argv = (args: string[]) => ["--import", TSX, MAIN, ...args];
  const apps: App[] = [];

  return {
    root,
    github,
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

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}
