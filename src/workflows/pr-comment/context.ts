import type { PRCommentBatchHistory, PRCommentPayload } from "../../github/poller.js";

/**
 * Builds the rich prompt for the coding agent. This is the heart of the
 * "no bridge" fix: instead of a raw comment, the agent gets PR title/body,
 * the file + line (for inline comments), and the surrounding diff hunk.
 */
export function buildPrompt(
  p: PRCommentPayload,
  history: PRCommentBatchHistory[] = [],
): string {
  const lines: string[] = [];

  lines.push("You are a coding review agent resolving GitHub pull request feedback.");
  lines.push("You are running inside an isolated checkout of the PR branch. Review the comments, inspect the repository, make the necessary changes, commit them, and stop.");
  lines.push("");
  lines.push(`Repository: ${p.repo.owner}/${p.repo.repo}`);
  lines.push(`PR #${p.prNumber}: ${p.prTitle}`);
  lines.push(`Branch (you are on it): ${p.headRef}  (base: ${p.baseRef})`);
  lines.push(`Batch: ${p.batchId}`);
  lines.push(`Comments in this batch: ${p.comments.length}`);
  if (p.prBody) {
    lines.push("");
    lines.push("--- PR description ---");
    lines.push(p.prBody);
    lines.push("--- end PR description ---");
  }

  const recentHistory = history.slice(-5);
  if (recentHistory.length > 0) {
    lines.push("");
    lines.push("--- recent automation changelog for this PR ---");
    for (const entry of recentHistory) {
      lines.push(
        `- ${entry.handledAt}: ${entry.summary} (${entry.commentKeys.length} comment${entry.commentKeys.length === 1 ? "" : "s"}, ${entry.commitCount} commit${entry.commitCount === 1 ? "" : "s"}, agent=${entry.agent}, exit=${entry.exitCode})`,
      );
    }
    lines.push("--- end changelog ---");
  }

  lines.push("");
  lines.push("--- comments to address ---");
  p.comments.forEach((comment, index) => {
    lines.push(`Comment ${index + 1}/${p.comments.length}`);
    lines.push(`Key: ${comment.key}`);
    lines.push(`Kind: ${comment.kind}`);
    lines.push(`Author: @${comment.author}`);
    lines.push(`Created at: ${comment.createdAt}`);
    if (comment.review) {
      lines.push(
        `Inline location: ${comment.review.path}` +
          (comment.review.line ? `:${comment.review.line}` : ""),
      );
      lines.push("Diff hunk:");
      lines.push("```diff");
      lines.push(comment.review.diffHunk);
      lines.push("```");
    }
    lines.push("Comment body:");
    lines.push(comment.body);
    lines.push("");
  });
  lines.push("--- end comments ---");
  lines.push("");
  lines.push("Instructions:");
  lines.push("- Treat this as PR review work: resolve every actionable comment in this batch, and leave non-actionable comments alone.");
  lines.push("- First inspect the relevant files, project structure, package scripts, and nearby patterns before editing.");
  lines.push("- Follow the repository's existing architecture, style, naming, tests, and conventions. Avoid unrelated refactors.");
  lines.push("- If your environment supports sub-agents or delegation, use them when it helps split independent comments, investigate unfamiliar areas, or parallelize review context gathering.");
  lines.push("- Keep coordination efficient: group related comments together, avoid duplicate investigation, and reconcile overlapping requests before editing.");
  lines.push("- Prefer one clear commit when the requested changes are related; use multiple commits only when it improves reviewability.");
  lines.push("- Run the most relevant validation available for the touched area when practical, and mention any validation you could not run in your final response.");
  lines.push("- Reference PR #" + p.prNumber + " in the commit message.");
  lines.push("- Do NOT push; the orchestrator will push for you.");
  lines.push("- Do NOT amend or rewrite unrelated history.");
  lines.push("- Do NOT rework older comments unless the changelog says prior automation missed something relevant to this batch.");
  return lines.join("\n");
}
