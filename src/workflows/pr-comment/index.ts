import type { Workflow, RunCtx } from "../types.js";
import type { Event } from "../../sources/types.js";
import type { PRCommentBatchHistory, PRCommentPayload } from "../../github/poller.js";
import { prHistoryKey } from "../../github/poller.js";
import { prepareWorkdir, cleanupWorkdir } from "../../runner/workdir.js";
import { runAgent } from "../../runner/executor.js";
import { buildPrompt } from "./context.js";
import { commitsAhead, pushBranch } from "./push.js";
import { MARKER_TAG } from "../../github/client.js";
import { log } from "../../log.js";

/**
 * Workflow #1: PR comment → coding agent → push.
 *
 * Flow: build context → isolated clone → run agent → count commits →
 * push (or post a "nothing to do" comment) → post marker summary comment.
 */
export function prCommentWorkflow(): Workflow {
  return {
    kind: "pr_comment",
    async handle(event: Event, ctx: RunCtx): Promise<void> {
      const p = event.payload as PRCommentPayload;
      const { repo, prNumber, headRef } = p;
      const slug = `${repo.owner}/${repo.repo}#${prNumber}`;
      log.info("handling pr_comment batch", {
        slug,
        batchId: p.batchId,
        comments: p.comments.length,
      });

      const historyKey = prHistoryKey(repo, prNumber);
      const history = ctx.store.get<PRCommentBatchHistory[]>(historyKey, []);
      const prompt = buildPrompt(p, history);
      const taskId = event.id.replace(/[^a-z0-9-]/gi, "_");

      const workdir = prepareWorkdir({
        stateDir: ctx.config.stateDir,
        repo,
        branch: headRef,
        taskId,
        token: ctx.config.githubToken,
      });

      try {
        const result = await runAgent(ctx.agent, {
          workdir: workdir.path,
          branch: headRef,
          prompt,
        });

        const ahead = commitsAhead(workdir.path);
        if (result.exitCode !== 0) {
          log.warn("agent exited non-zero", { slug, exitCode: result.exitCode });
        }

        const authors = [...new Set(p.comments.map((c) => c.author))];
        const authorText =
          authors.length === 1
            ? `@${authors[0]}`
            : authors.map((author) => `@${author}`).join(", ");
        const commentText = `${p.comments.length} comment${p.comments.length === 1 ? "" : "s"}`;
        let body: string;
        if (ahead > 0) {
          pushBranch(workdir.path, headRef);
          body = `${MARKER_TAG} Applied changes for ${authorText}'s ${commentText} (${ahead} commit${ahead > 1 ? "s" : ""}).`;
          log.info("pushed changes", { slug, commits: ahead });
        } else {
          body = `${MARKER_TAG} No changes produced for ${authorText}'s ${commentText}.`;
          log.info("no changes to push", { slug });
        }

        await ctx.postMarkerComment({ repo, prNumber, body });
        recordBatchHistory(ctx, historyKey, {
          batchId: p.batchId,
          handledAt: new Date().toISOString(),
          agent: ctx.agent.name,
          exitCode: result.exitCode,
          commitCount: ahead,
          commentKeys: p.comments.map((c) => c.key),
          summary: summarizeBatch(p, ahead),
        });
      } finally {
        cleanupWorkdir(workdir, ctx.config.keepWorkdirs);
      }
    },
  };
}

function summarizeBatch(p: PRCommentPayload, commitCount: number): string {
  const files = [
    ...new Set(
      p.comments
        .map((comment) => comment.review?.path)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  const authors = [...new Set(p.comments.map((comment) => `@${comment.author}`))];
  const fileText = files.length > 0 ? ` on ${files.slice(0, 5).join(", ")}` : "";
  const moreFiles = files.length > 5 ? ` and ${files.length - 5} more file(s)` : "";
  const result = commitCount > 0 ? `produced ${commitCount} commit(s)` : "produced no commits";
  return `Handled batch from ${authors.join(", ")} with ${p.comments.length} comment(s)${fileText}${moreFiles}; ${result}`;
}

function recordBatchHistory(
  ctx: RunCtx,
  key: string,
  entry: PRCommentBatchHistory,
): void {
  ctx.store.update<PRCommentBatchHistory[]>(
    key,
    (current) => [...(current ?? []), entry].slice(-20),
    [],
  );
}
