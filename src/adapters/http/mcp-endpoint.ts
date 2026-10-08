import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ReviewApi } from "../../services/review-api.js";
import { registerReviewTools } from "../../services/review-tools.js";
import { send } from "./http-util.js";

/**
 * Answers one MCP request. The endpoint is stateless: each POST gets a new
 * server and transport and a JSON reply, so no MCP session outlives it.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
  api: ReviewApi,
): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, { error: "the MCP endpoint takes POST only" });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    send(res, 400, { error: "request body is not valid JSON" });
    return;
  }
  const server = new McpServer({ name: "guided-review", version: "1.0.0" });
  registerReviewTools(server, api);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
