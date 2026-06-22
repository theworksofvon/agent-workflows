import type { PRCommentPayload } from "../../github/poller.js";

/**
 * Builds the rich prompt for the coding agent. This is the heart of the
 * "no bridge" fix: instead of a raw comment, the agent gets PR title/body,
 * the file + line (for inline comments), and the surrounding diff hunk.
 */
export function buildPrompt(p: PRCommentPayload): string {
  const lines: string[] = [];

  lines.push("You are acting on a pull request review comment. Make the requested change, commit it, and stop.");
  lines.push("");
  lines.push(`Repository: ${p.repo.owner}/${p.repo.repo}`);
  lines.push(`PR #${p.prNumber}: ${p.prTitle}`);
  lines.push(`Branch (you are on it): ${p.headRef}  (base: ${p.baseRef})`);
  if (p.prBody) {
    lines.push("");
    lines.push("--- PR description ---");
    lines.push(p.prBody);
    lines.push("--- end PR description ---");
  }

  if (p.review) {
    lines.push("");
    lines.push(`This is an INLINE review comment on file: ${p.review.path}` + (p.review.line ? `:${p.review.line}` : ""));
    lines.push("Surrounding diff hunk for context:");
    lines.push("```diff");
    lines.push(p.review.diffHunk);
    lines.push("```");
  }

  lines.push("");
  lines.push(`Comment author: @${p.comment.author}`);
  lines.push("--- comment ---");
  lines.push(p.comment.body);
  lines.push("--- end comment ---");
  lines.push("");
  lines.push("Instructions:");
  lines.push("- Implement the change the comment asks for, focused and minimal.");
  lines.push("- Commit with a clear message referencing PR #" + p.prNumber + ".");
  lines.push("- Do NOT push; the orchestrator will push for you.");
  lines.push("- Do NOT amend or rewrite unrelated history.");
  return lines.join("\n");
}
