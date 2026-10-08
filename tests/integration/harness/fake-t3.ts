import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * A T3 Code stand-in: the outside-agent OAuth endpoints, which approve every
 * sign-in at once, and an MCP endpoint with the thread and project tools
 * that the app calls. Every tool call lands in `calls`.
 */
export interface FakeT3 {
  mcpUrl: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** The projects that t3_project_list returns. */
  projects: Array<Record<string, unknown>>;
  /** Every live thread by id. */
  threads: Map<string, { title: string; projectId: string | null }>;
  /** Makes T3 answer 401 to every token issued so far. */
  revokeTokens(): void;
  deleteThread(id: string): void;
  close(): Promise<void>;
}

export const FAKE_T3_ENVIRONMENT = "env-local";

export async function startFakeT3(): Promise<FakeT3> {
  const tokens = new Set<string>();
  const codes = new Map<string, string>();
  const calls: FakeT3["calls"] = [];
  const threads: FakeT3["threads"] = new Map();
  const projects: FakeT3["projects"] = [];
  let origin = "";

  const tools = (server: McpServer) => {
    const record =
      (tool: string, run: (args: Record<string, unknown>) => unknown) =>
      (args: Record<string, unknown>) => {
        calls.push({ tool, args });
        const value = run(args);
        if (value instanceof Error)
          return {
            isError: true,
            content: [{ type: "text" as const, text: value.message }],
          };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value as Record<string, unknown>,
        };
      };
    const link = (id: string, title: string) =>
      `[${title}](t3-thread://v1/${FAKE_T3_ENVIRONMENT}/${id})`;
    server.registerTool(
      "t3_project_list",
      { inputSchema: { limit: z.number().optional() } },
      record("t3_project_list", () => ({ projects, nextCursor: null })),
    );
    server.registerTool(
      "t3_thread_list",
      {
        inputSchema: {
          projectId: z.string().nullable().optional(),
          titleContains: z.string().nullable().optional(),
        },
      },
      record("t3_thread_list", (args) => ({
        threads: [...threads]
          .filter(
            ([, t]) =>
              (args.projectId ?? null) === t.projectId &&
              t.title.includes(String(args.titleContains ?? "")),
          )
          .map(([id, t]) => ({
            threadId: id,
            title: t.title,
            link: link(id, t.title),
          })),
        nextCursor: null,
      })),
    );
    server.registerTool(
      "t3_thread_read",
      { inputSchema: { threadId: z.string(), limit: z.number().optional() } },
      record("t3_thread_read", (args) => {
        const thread = threads.get(String(args.threadId));
        if (!thread) return new Error(`Thread not found: ${args.threadId}`);
        return {
          thread: {
            id: args.threadId,
            title: thread.title,
            link: link(String(args.threadId), thread.title),
          },
          items: [],
        };
      }),
    );
    server.registerTool(
      "t3_thread_launch",
      {
        inputSchema: {
          title: z.string(),
          projectId: z.string().nullable().optional(),
          scratch: z.boolean().nullable().optional(),
          message: z.string().nullable().optional(),
          workspaceStrategy: z
            .object({ type: z.string() })
            .nullable()
            .optional(),
        },
      },
      record("t3_thread_launch", (args) => {
        const id = `thread-${randomUUID().slice(0, 8)}`;
        const title = String(args.title);
        threads.set(id, {
          title,
          projectId: (args.projectId as string | undefined) ?? null,
        });
        return { threadId: id, link: link(id, title) };
      }),
    );
    server.registerTool(
      "t3_thread_send",
      {
        inputSchema: {
          threadId: z.string(),
          message: z.string(),
          mode: z.string().nullable().optional(),
          clientRequestId: z.string().nullable().optional(),
        },
      },
      record("t3_thread_send", (args) =>
        threads.has(String(args.threadId))
          ? { accepted: true }
          : new Error(`Thread not found: ${args.threadId}`),
      ),
    );
  };

  const server = createServer((req, res) => {
    void readText(req).then(async (raw) => {
      const url = new URL(req.url!, origin);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/mcp/authorize`,
          token_endpoint: `${origin}/oauth/mcp/token`,
          registration_endpoint: `${origin}/oauth/mcp/register`,
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/oauth/mcp/register") {
        const { redirect_uris } = JSON.parse(raw) as {
          redirect_uris: string[];
        };
        return json(201, {
          client_id: `client-${redirect_uris[0]}`,
          redirect_uris,
        });
      }
      if (url.pathname === "/oauth/mcp/authorize") {
        const p = url.searchParams;
        if (
          p.get("code_challenge_method") !== "S256" ||
          p.get("resource") !== `${origin}/mcp`
        )
          return json(400, { error: "invalid_request" });
        const code = randomUUID();
        codes.set(code, p.get("client_id")!);
        const back = new URL(p.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.get("state")!);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === "/oauth/mcp/token") {
        const form = new URLSearchParams(raw);
        const code = form.get("code")!;
        if (
          codes.get(code) !== form.get("client_id") ||
          !form.get("code_verifier") ||
          form.get("resource") !== `${origin}/mcp`
        )
          return json(400, { error: "invalid_grant" });
        codes.delete(code);
        const token = `t3tok-${randomUUID()}`;
        tokens.add(token);
        return json(200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: 30 * 24 * 3600,
        });
      }
      if (url.pathname === "/mcp") {
        const auth = String(req.headers.authorization ?? "");
        if (!tokens.has(auth.replace(/^Bearer /, "")))
          return json(401, { error: "invalid_mcp_credential" });
        const mcp = new McpServer({ name: "t3", version: "1.0.0" });
        tools(mcp);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : {});
        return;
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    mcpUrl: `${origin}/mcp`,
    calls,
    projects,
    threads,
    revokeTokens: () => tokens.clear(),
    deleteThread: (id) => threads.delete(id),
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => done(text));
  });
}
