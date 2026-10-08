import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../log.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type ReviewApi,
} from "../../services/review-api.js";
import { errorMessage } from "../../domain/util.js";
import { listen, readBody, send, type ServerHandle } from "./http-util.js";
import { handleMcp } from "./mcp-endpoint.js";

/** web/dist at the repository root, from both src/ and the compiled dist/. */
export const DEFAULT_STATIC_DIR = fileURLToPath(
  new URL("../../../web/dist", import.meta.url),
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Guided review</title></head>
<body>
<h1>Guided review</h1>
<p>The web app is not built. Run <code>mise run web:build</code>, then reload this page.</p>
</body>
</html>
`;

type Reply = { status: number; body: unknown };

const EVENTS_PATH = /^\/api\/sessions\/([^/]+)\/events$/;
/** A comment line this often keeps an idle event stream open through proxies. */
const KEEPALIVE_MS = 25_000;
type Handler = (
  params: string[],
  body: unknown,
  query: URLSearchParams,
) => Reply | Promise<Reply>;

/**
 * Serves the guided review JSON API under `/api` and the built web app for
 * every other GET, falling back to index.html so client routes load.
 */
export function startReviewServer(args: {
  host: string;
  port: number;
  /**
   * The port in the browser's address when it differs from `port`, as when
   * Docker publishes the app on another host port.
   */
  publicPort?: number;
  api: ReviewApi;
  staticDir?: string;
}): Promise<ServerHandle> {
  const staticDir = resolve(args.staticDir ?? DEFAULT_STATIC_DIR);
  const routes = routeTable(args.api);
  const server = createServer((req, res) => {
    // A TCP listener always reports an AddressInfo, carrying the real port for port 0.
    const { port } = server.address() as AddressInfo;
    const refusal = refuse(
      req,
      [args.host, "127.0.0.1", "localhost"],
      [port, args.publicPort ?? port],
    );
    if (refusal) {
      res.setHeader("connection", "close");
      send(res, refusal.status, { error: refusal.error });
      return;
    }
    // Split rather than `new URL`: a target like `//[` throws there.
    const [path, search = ""] = String(req.url).split(/\?(.*)/s);
    if (path === "/mcp") {
      readBody(req, res, { error: "payload too large" }, (body) => {
        void handleMcp(req, res, body, args.api).catch((err: unknown) => {
          log.error("mcp request failed", { error: errorMessage(err) });
          if (!res.headersSent) send(res, 500, { error: errorMessage(err) });
        });
      });
      return;
    }
    const events = EVENTS_PATH.exec(path);
    if (events && req.method === "GET") {
      streamEvents(args.api, decodeURIComponent(events[1]), res);
      return;
    }
    if (path.startsWith("/api/")) {
      readBody(req, res, { error: "payload too large" }, (body) => {
        void handleApi(routes, req, path, search, body, res);
      });
      return;
    }
    if (req.method !== "GET") {
      send(res, 404, { error: "not found" });
      return;
    }
    void serveStatic(staticDir, path, res);
  });
  return listen(server, args.host, args.port);
}

/**
 * Guards a server that can start agent runs and post to GitHub. The Host
 * check defeats DNS rebinding. A browser sends Origin on every write, so the
 * Origin check stops cross-site writes, and requiring JSON for a body forces
 * a CORS preflight that this server never answers.
 */
function refuse(
  req: IncomingMessage,
  names: string[],
  ports: number[],
): { status: number; error: string } | null {
  const hosts = names.flatMap((name) => ports.map((port) => `${name}:${port}`));
  if (!hosts.includes(String(req.headers.host)))
    return { status: 403, error: "host not allowed" };
  if (req.method === "GET") return null;
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`))
    return { status: 403, error: "origin not allowed" };
  const hasBody =
    req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"] ?? 0) > 0;
  const type = req.headers["content-type"] ?? "";
  if (hasBody && !type.startsWith("application/json"))
    return { status: 415, error: "content-type must be application/json" };
  return null;
}

function routeTable(api: ReviewApi): Array<[string, RegExp, Handler]> {
  const ok = (body: unknown): Reply => ({ status: 200, body });
  const created = (body: unknown): Reply => ({ status: 201, body });
  return [
    ["GET", /^health$/, () => ok(api.health())],
    ["GET", /^sessions$/, () => ok(api.listSessions())],
    ["POST", /^sessions$/, async (_, b) => created(await api.createSession(b))],
    ["GET", /^sessions\/([^/]+)$/, ([id]) => ok(api.getSession(id))],
    [
      "POST",
      /^sessions\/([^/]+)\/rerun$/,
      async ([id], b) => created(await api.rerun(id, b)),
    ],
    [
      "PUT",
      /^sessions\/([^/]+)\/account$/,
      async ([id], b) => ok(await api.setSessionAccount(id, b)),
    ],
    [
      "PUT",
      /^sessions\/([^/]+)\/chapters\/([^/]+)$/,
      ([id, chapter], b) => ok(api.setChapter(id, chapter, b)),
    ],
    ["PUT", /^sessions\/([^/]+)\/files$/, ([id], b) => ok(api.setFile(id, b))],
    [
      "PUT",
      /^sessions\/([^/]+)\/findings\/([^/]+)$/,
      ([id, finding], b) => ok(api.setVerdict(id, finding, b)),
    ],
    [
      "POST",
      /^sessions\/([^/]+)\/comments$/,
      ([id], b) => created(api.addComment(id, b)),
    ],
    [
      "DELETE",
      /^sessions\/([^/]+)\/comments\/([^/]+)$/,
      ([id, comment]) => ok(api.deleteComment(id, comment)),
    ],
    [
      "GET",
      /^sessions\/([^/]+)\/publish$/,
      ([id], _, q) => ok(api.previewPublish(id, q.get("event"))),
    ],
    [
      "POST",
      /^sessions\/([^/]+)\/publish$/,
      async ([id], b) => ok(await api.publish(id, b)),
    ],
    ["GET", /^sessions\/([^/]+)\/discuss$/, ([id]) => ok(api.discuss(id))],
    ["GET", /^focus$/, () => ok(api.getFocus())],
    ["PUT", /^focus$/, (_, b) => ok(api.setFocus(b))],
    [
      "GET",
      /^sessions\/([^/]+)\/checks$/,
      async ([id]) => ok(await api.sessionChecks(id)),
    ],
    ["GET", /^accounts$/, async () => ok(await api.accounts())],
    [
      "PUT",
      /^accounts\/current$/,
      async (_, b) => ok(await api.setCurrentAccount(b)),
    ],
    [
      "GET",
      /^inbox$/,
      async (_, __, q) => ok(await api.inbox(q.get("refresh") === "1")),
    ],
    [
      "GET",
      /^repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)$/,
      async ([owner, repo, number]) =>
        ok(await api.getPull(owner, repo, number)),
    ],
    [
      "GET",
      /^repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/checks$/,
      async ([owner, repo, number]) =>
        ok(await api.pullChecks(owner, repo, number)),
    ],
    [
      "GET",
      /^repos\/([^/]+)\/([^/]+)\/pulls$/,
      async ([owner, repo]) => ok(await api.listPulls(owner, repo)),
    ],
  ];
}

async function handleApi(
  routes: Array<[string, RegExp, Handler]>,
  req: IncomingMessage,
  path: string,
  search: string,
  raw: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const rest = path.slice("/api/".length);
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(rest);
      if (!match || req.method !== method) continue;
      const params = match.slice(1).map(decodeSegment);
      const reply = await handler(
        params,
        parseBody(raw),
        new URLSearchParams(search),
      );
      send(res, reply.status, reply.body);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    const status =
      err instanceof NotFoundError
        ? 404
        : err instanceof BadRequestError
          ? 400
          : err instanceof ConflictError
            ? 409
            : 500;
    const message = errorMessage(err);
    if (status === 500)
      log.error("review api request failed", {
        method: req.method,
        path,
        error: message,
      });
    send(res, status, { error: message });
  }
}

/**
 * A server-sent events stream that says "changed" each time the session's
 * human state changes. It opens with "ready", so a client knows it listens.
 */
function streamEvents(api: ReviewApi, id: string, res: ServerResponse): void {
  let stop: () => void;
  try {
    stop = api.subscribe(id, () => res.write("event: changed\ndata: {}\n\n"));
  } catch (err) {
    send(res, err instanceof NotFoundError ? 404 : 500, {
      error: errorMessage(err),
    });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write("event: ready\ndata: {}\n\n");
  const keepAlive = setInterval(
    () => res.write(": keepalive\n\n"),
    KEEPALIVE_MS,
  );
  keepAlive.unref();
  res.on("close", () => {
    clearInterval(keepAlive);
    stop();
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError(`malformed path segment: ${segment}`);
  }
}

function parseBody(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }
}

async function serveStatic(
  root: string,
  path: string,
  res: ServerResponse,
): Promise<void> {
  const file = staticPath(root, path);
  if (file === null) {
    send(res, 404, { error: "not found" });
    return;
  }
  const target = (await isFile(file)) ? file : join(root, "index.html");
  try {
    const content = await readFile(target);
    res.statusCode = 200;
    res.setHeader(
      "content-type",
      CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
    );
    res.end(content);
  } catch {
    res.statusCode = 200;
    res.setHeader("content-type", CONTENT_TYPES[".html"]);
    res.end(NOT_BUILT_PAGE);
  }
}

/** The file a request path names inside root, or null when it would leave root. */
function staticPath(root: string, path: string): string | null {
  let segments: string[];
  try {
    segments = path.split("/").map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  // A decoded separator or NUL would let one segment name a different path.
  if (segments.some((s) => /[/\\\0]/.test(s))) return null;
  const file = resolve(root, ...segments.filter((s) => s !== ""));
  return file === root || file.startsWith(root + sep) ? file : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
