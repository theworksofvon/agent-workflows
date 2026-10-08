import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { ReviewApi } from "./review-api.js";

const REVIEW = z.string().describe("The review session id");

/**
 * The review as MCP tools, for an agent that discusses it with the reviewer.
 * Each tool calls the ReviewApi method behind the matching HTTP route, so the
 * rules are the same. No tool publishes: only the reviewer publishes, from
 * the app.
 */
export function registerReviewTools(server: McpServer, api: ReviewApi): void {
  server.registerTool(
    "get_review",
    {
      description:
        "Read a guided review: the PR, the GitHub account it is reviewed as (session.account), the guide, the agent findings with their ids, and what the reviewer already did (human).",
      inputSchema: { review: REVIEW },
      annotations: { readOnlyHint: true },
    },
    ({ review }) => result(() => api.getSession(review)),
  );
  server.registerTool(
    "get_focus",
    {
      description:
        "What the reviewer has open in the review app now: the review, its PR and account, the tab, and the chapter, finding, file, or lines. Call it when the reviewer says 'this' or 'here'. Null when the app has not reported a focus.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => result(() => api.getFocus()),
  );
  server.registerTool(
    "set_verdict",
    {
      description:
        "Record the reviewer's verdict on an agent finding. Use it only after the reviewer confirms. A null verdict clears it.",
      inputSchema: {
        review: REVIEW,
        finding: z.string().describe("The finding id from get_review"),
        verdict: z.enum(["agree", "disagree", "unsure"]).nullable(),
        note: z.string().default("").describe("The reviewer's reason"),
      },
    },
    ({ review, finding, verdict, note }) =>
      result(() => api.setVerdict(review, finding, { verdict, note })),
  );
  server.registerTool(
    "add_comment",
    {
      description:
        "Add the reviewer's own comment on a line of a changed file, on the new side of the diff. It publishes as the reviewer's. Use it only after the reviewer confirms the text.",
      inputSchema: {
        review: REVIEW,
        path: z.string(),
        line: z.number().int().positive(),
        body: z.string(),
      },
    },
    ({ review, path, line, body }) =>
      result(() => api.addComment(review, { path, line, body })),
  );
  server.registerTool(
    "delete_comment",
    {
      description: "Delete one of the reviewer's comments.",
      inputSchema: { review: REVIEW, comment: z.string() },
    },
    ({ review, comment }) => result(() => api.deleteComment(review, comment)),
  );
  server.registerTool(
    "mark_reviewed",
    {
      description:
        "Mark a chapter of the guide, or a file, as reviewed or not. Give chapter or path.",
      inputSchema: {
        review: REVIEW,
        chapter: z.string().optional(),
        path: z.string().optional(),
        reviewed: z.boolean(),
      },
    },
    ({ review, chapter, path, reviewed }) =>
      result(() =>
        chapter !== undefined
          ? api.setChapter(review, chapter, { reviewed })
          : api.setFile(review, { path: path ?? "", viewed: reviewed }),
      ),
  );
}

/** A refused operation is a tool error the agent can read, not a crash. */
async function result(run: () => unknown): Promise<CallToolResult> {
  try {
    const value = (await run()) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    return { isError: true, content: [{ type: "text", text: err.message }] };
  }
}
