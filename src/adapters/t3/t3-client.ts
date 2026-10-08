import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DomainError } from "../../domain/errors.js";

/** T3 refused the token: it expired, or the reviewer removed it in T3. */
export class T3UnauthorizedError extends DomainError {}
/** Nothing answered at the T3 MCP URL. */
export class T3UnreachableError extends DomainError {}
/** A T3 tool ran and failed, for example on a thread that does not exist. */
export class T3ToolError extends DomainError {}

/** Calls tools on T3's MCP endpoint as the signed-in app. */
export interface T3Tools {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function connectT3(
  mcpUrl: string,
  token: string,
): Promise<T3Tools> {
  const client = new Client({ name: "guided-review", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    throw t3Error(err, mcpUrl);
  }
  return {
    async call(tool, args) {
      let res;
      try {
        res = await client.callTool({ name: tool, arguments: args });
      } catch (err) {
        throw t3Error(err, mcpUrl);
      }
      const text =
        (res.content as Array<{ type: string; text?: string }>).find(
          (c) => c.type === "text",
        )?.text ?? "";
      if (res.isError) throw new T3ToolError(`${tool}: ${text}`);
      if (res.structuredContent) return res.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

function t3Error(err: unknown, mcpUrl: string): Error {
  if (err instanceof StreamableHTTPError && err.code === 401)
    return new T3UnauthorizedError(
      "T3 refused the sign-in: it expired or was removed. Connect T3 again.",
    );
  if (
    err instanceof TypeError ||
    (err as { code?: string }).code === "ECONNREFUSED"
  )
    return new T3UnreachableError(`T3 is not reachable at ${mcpUrl}`);
  // The SDK reports a 401 without its own error class in some paths.
  if (/\b401\b|unauthorized/i.test(String((err as Error).message)))
    return new T3UnauthorizedError(
      "T3 refused the sign-in: it expired or was removed. Connect T3 again.",
    );
  return err instanceof Error ? err : new Error(String(err));
}
