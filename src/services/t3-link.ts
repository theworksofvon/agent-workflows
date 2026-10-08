import { randomBytes } from "node:crypto";
import type { SettingsStore } from "../adapters/state/settings.js";
import type { ReviewSession } from "../adapters/state/review-sessions.js";
import type {
  T3ThreadRow,
  T3ThreadStore,
} from "../adapters/state/t3-threads.js";
import {
  T3ToolError,
  T3UnauthorizedError,
  type T3Tools,
} from "../adapters/t3/t3-client.js";
import { pkcePair, t3OAuth, type T3Token } from "../adapters/t3/oauth.js";
import { DomainError } from "../domain/errors.js";

/** The reviewer must connect T3 first, or connect it again. */
export class T3NotConnectedError extends DomainError {}
export class T3InputError extends DomainError {}

export interface T3Status {
  connected: boolean;
  mcpUrl: string | null;
  expiresAt: string | null;
}

export interface T3Thread {
  id: string;
  title: string;
  /** The thread in T3's web app. */
  url: string | null;
  created: boolean;
}

export interface T3LinkPorts {
  settings: SettingsStore;
  threads: T3ThreadStore;
  /** T3_MCP_URL, used until the reviewer enters another URL. */
  defaultMcpUrl: string | null;
  /** The review app's address in the reviewer's browser. */
  appUrl: string;
  connect(mcpUrl: string, token: string): Promise<T3Tools>;
}

interface StoredToken extends T3Token {
  mcpUrl: string;
}

interface StoredClient {
  mcpUrl: string;
  redirectUri: string;
  clientId: string;
}

interface PendingSignIn {
  mcpUrl: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  expires: number;
  /** The app page to go back to, as a `#/` route. */
  returnTo: string;
}

const MCP_URL = "t3.mcpUrl";
const CLIENT = "t3.client";
const TOKEN = "t3.token";
/** A sign-in that the reviewer does not finish in this time must start over. */
const SIGN_IN_MS = 10 * 60 * 1000;

/**
 * The app's link to T3 Code: the OAuth sign-in, and 1 thread for each
 * account's review of a PR. The token lives only in `settings`; nothing here
 * returns or logs it.
 */
export function t3Link(ports: T3LinkPorts) {
  const { settings, threads } = ports;
  const pending = new Map<string, PendingSignIn>();
  const opening = new Map<string, Promise<T3Thread>>();
  const redirectUri = `${ports.appUrl}/api/t3/callback`;

  const mcpUrl = (): string | null =>
    settings.get(MCP_URL) ?? ports.defaultMcpUrl;

  const token = (): StoredToken | null => {
    const raw = settings.get(TOKEN);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredToken;
    if (
      stored.mcpUrl !== mcpUrl() ||
      Date.parse(stored.expiresAt) <= Date.now()
    )
      return null;
    return stored;
  };

  const status = (): T3Status => {
    const current = token();
    return {
      connected: current !== null,
      mcpUrl: mcpUrl(),
      expiresAt: current?.expiresAt ?? null,
    };
  };

  /** Runs `use` with T3's tools; a refused token disconnects the app. */
  const withT3 = async <T>(use: (t3: T3Tools) => Promise<T>): Promise<T> => {
    const current = token();
    if (!current)
      throw new T3NotConnectedError("Connect T3 first: T3 is not connected.");
    let tools: T3Tools | null = null;
    try {
      tools = await ports.connect(current.mcpUrl, current.token);
      return await use(tools);
    } catch (err) {
      if (err instanceof T3UnauthorizedError) {
        settings.delete(TOKEN);
        throw new T3NotConnectedError(err.message);
      }
      throw err;
    } finally {
      await tools?.close();
    }
  };

  const clientId = async (url: string): Promise<string> => {
    const raw = settings.get(CLIENT);
    const stored = raw ? (JSON.parse(raw) as StoredClient) : null;
    if (stored?.mcpUrl === url && stored.redirectUri === redirectUri)
      return stored.clientId;
    const id = await t3OAuth(url).register(redirectUri);
    settings.set(
      CLIENT,
      JSON.stringify({ mcpUrl: url, redirectUri, clientId: id }),
    );
    return id;
  };

  /** Finds the PR's thread, or launches it, and tells it about `session`. */
  const open = (t3: T3Tools, session: ReviewSession): Promise<T3Thread> => {
    const key = threadKey(session);
    const running = opening.get(key);
    if (running) return running;
    const run = (async (): Promise<T3Thread> => {
      const title = threadTitle(session);
      const row = threads.get(key);
      if (row && (await exists(t3, row.threadId))) {
        if (row.sessionId !== session.id) {
          await t3.call("t3_thread_send", {
            threadId: row.threadId,
            message: newSessionMessage(session, ports.appUrl),
            mode: "auto",
            clientRequestId: `session-${session.id}`,
          });
          threads.save({ ...row, sessionId: session.id });
        }
        return thread(row, title, false);
      }
      const projectId = await projectFor(t3, session);
      const found = await findThread(t3, projectId, title);
      if (found) {
        const saved = save(key, found, projectId, session);
        await t3.call("t3_thread_send", {
          threadId: found.threadId,
          message: newSessionMessage(session, ports.appUrl),
          mode: "auto",
          clientRequestId: `session-${session.id}`,
        });
        return thread(saved, title, false);
      }
      const launched = (await t3.call("t3_thread_launch", {
        title,
        message: firstMessage(session, ports.appUrl),
        ...(projectId
          ? { projectId, workspaceStrategy: { type: "root" } }
          : { scratch: true }),
      })) as { threadId: string; link: string };
      return thread(save(key, launched, projectId, session), title, true);
    })();
    opening.set(key, run);
    return run.finally(() => opening.delete(key));
  };

  const save = (
    key: string,
    found: { threadId: string; link: string },
    projectId: string | null,
    session: ReviewSession,
  ): T3ThreadRow => {
    const row: T3ThreadRow = {
      key,
      threadId: found.threadId,
      link: found.link,
      projectId,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    };
    threads.save(row);
    return row;
  };

  const thread = (
    row: T3ThreadRow,
    title: string,
    created: boolean,
  ): T3Thread => ({
    id: row.threadId,
    title,
    url: webUrl(token()?.mcpUrl ?? mcpUrl() ?? "", row.link),
    created,
  });

  return {
    status,

    /** Starts a sign-in; the browser goes to the returned T3 page. */
    async connect(
      body: Record<string, unknown>,
    ): Promise<{ authorizeUrl: string }> {
      const given = typeof body.mcpUrl === "string" ? body.mcpUrl.trim() : "";
      const url = given || mcpUrl();
      if (!url) throw new T3InputError("Enter T3's MCP URL.");
      if (!isHttpUrl(url))
        throw new T3InputError(`Not an http or https URL: ${url}`);
      settings.set(MCP_URL, url);
      const id = await clientId(url);
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString("base64url");
      const now = Date.now();
      for (const [key, p] of pending) if (p.expires <= now) pending.delete(key);
      const back = typeof body.returnTo === "string" ? body.returnTo : "";
      pending.set(state, {
        returnTo: /^#\/[\w/%.-]*$/.test(back) ? back : "#/",
        mcpUrl: url,
        clientId: id,
        redirectUri,
        verifier,
        expires: now + SIGN_IN_MS,
      });
      return {
        authorizeUrl: await t3OAuth(url).authorizeUrl({
          clientId: id,
          redirectUri,
          state,
          challenge,
        }),
      };
    },

    /** Finishes a sign-in from T3's redirect; returns the page to go back to. */
    async callback(query: URLSearchParams): Promise<string> {
      const state = query.get("state") ?? "";
      const sign = pending.get(state);
      pending.delete(state);
      if (!sign || sign.expires <= Date.now())
        throw new T3InputError("This sign-in expired. Connect T3 again.");
      const refused = query.get("error");
      if (refused)
        throw new T3InputError(
          `T3 did not approve the sign-in: ${query.get("error_description") ?? refused}`,
        );
      const issued = await t3OAuth(sign.mcpUrl).exchange({
        clientId: sign.clientId,
        redirectUri: sign.redirectUri,
        code: query.get("code") ?? "",
        verifier: sign.verifier,
      });
      settings.set(TOKEN, JSON.stringify({ ...issued, mcpUrl: sign.mcpUrl }));
      return sign.returnTo;
    },

    disconnect(): T3Status {
      settings.delete(TOKEN);
      return status();
    },

    openThread(session: ReviewSession): Promise<T3Thread> {
      return withT3((t3) => open(t3, session));
    },

    /** Sends the reviewer's question to the PR's thread. */
    ask(
      session: ReviewSession,
      body: Record<string, unknown>,
    ): Promise<T3Thread> {
      const message = askMessage(session, body);
      const requestId =
        typeof body.requestId === "string" && body.requestId !== ""
          ? body.requestId
          : randomBytes(8).toString("hex");
      return withT3(async (t3) => {
        const found = await open(t3, session);
        await t3.call("t3_thread_send", {
          threadId: found.id,
          message,
          mode: "auto",
          clientRequestId: `ask-${requestId}`,
        });
        return found;
      });
    },
  };
}

export type T3Link = ReturnType<typeof t3Link>;

export function threadKey(s: ReviewSession): string {
  return `${s.account}:${prName(s)}`;
}

export function threadTitle(s: ReviewSession): string {
  return `Review: ${prName(s)} as ${s.account}`;
}

function prName(s: ReviewSession): string {
  return `${s.repo.owner}/${s.repo.repo}#${s.prNumber}`;
}

function firstMessage(s: ReviewSession, appUrl: string): string {
  const page = `${appUrl}/#/s/${encodeURIComponent(s.id)}`;
  return [
    `Use the guided-review skill to discuss review ${s.id} of ${prName(s)}, reviewed as the GitHub account ${s.account}.`,
    `The review app is at ${appUrl}; its MCP server is "guided-review".`,
    `First, open ${page} in the preview pane with preview_open. Then call get_review, and wait for my questions.`,
    "Do not post anything to GitHub. I publish the review from the app.",
  ].join("\n");
}

function newSessionMessage(s: ReviewSession, appUrl: string): string {
  const page = `${appUrl}/#/s/${encodeURIComponent(s.id)}`;
  return [
    `The review of ${prName(s)} as ${s.account} ran again. Use review ${s.id} from now on.`,
    `Open ${page} in the preview pane with preview_open, then call get_review.`,
  ].join("\n");
}

function askMessage(s: ReviewSession, body: Record<string, unknown>): string {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") throw new T3InputError("text must not be empty");
  const path = typeof body.path === "string" ? body.path : null;
  const lines = body.lines as { start?: unknown; end?: unknown } | undefined;
  const finding = typeof body.finding === "string" ? body.finding : null;
  const range =
    lines && Number.isInteger(lines.start) && Number.isInteger(lines.end)
      ? lines.start === lines.end
        ? `:${lines.start as number}`
        : `:${lines.start as number}–${lines.end as number}`
      : "";
  const where = path ? `${path}${range}` : "this review";
  const about = [
    finding ? `finding ${finding}` : null,
    `review ${s.id}`,
    `as ${s.account}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `About ${where} (${about}):\n${text}`;
}

async function exists(t3: T3Tools, threadId: string): Promise<boolean> {
  try {
    await t3.call("t3_thread_read", { threadId, limit: 1 });
    return true;
  } catch (err) {
    if (err instanceof T3ToolError) return false;
    throw err;
  }
}

/** The T3 project whose GitHub repository is the PR's, or null. */
async function projectFor(
  t3: T3Tools,
  s: ReviewSession,
): Promise<string | null> {
  const same = (a: unknown, b: string) =>
    typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = (await t3.call("t3_project_list", {
      limit: 100,
      cursor,
    })) as {
      projects: Array<{
        id: string;
        repositoryIdentity: Record<string, unknown> | null;
      }>;
      nextCursor: number | null;
    };
    const match = page.projects.find((p) => {
      const repo = p.repositoryIdentity;
      return (
        repo !== null &&
        same(repo.provider, "github") &&
        same(repo.owner, s.repo.owner) &&
        same(repo.name, s.repo.repo)
      );
    });
    if (match) return match.id;
    cursor = page.nextCursor ?? null;
  }
  return null;
}

/** A thread with the exact title, lost from the table but still in T3. */
async function findThread(
  t3: T3Tools,
  projectId: string | null,
  title: string,
): Promise<{ threadId: string; link: string } | null> {
  if (projectId === null) return null;
  const list = (await t3.call("t3_thread_list", {
    projectId,
    titleContains: title,
    limit: 20,
  })) as { threads: Array<{ threadId: string; title: string; link: string }> };
  return list.threads.find((t) => t.title === title) ?? null;
}

/**
 * T3's web route for a thread, `<origin>/<environment>/<thread>`, from its
 * `t3-thread://v1/<environment>/<thread>` link.
 */
function webUrl(mcpUrl: string, link: string): string | null {
  const m = /t3-thread:\/\/v1\/([^/)]+)\/([^/)]+)/.exec(link);
  if (!m || !isHttpUrl(mcpUrl)) return null;
  return `${new URL(mcpUrl).origin}/${m[1]}/${m[2]}`;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
