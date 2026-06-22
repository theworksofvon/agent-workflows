import type { Workflow, RunCtx } from "../types.js";
import type { Event } from "../../sources/types.js";
import type { PRCommentPayload } from "../../github/poller.js";
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
      log.info("handling pr_comment", { slug, author: p.comment.author, review: !!p.review });

      const prompt = buildPrompt(p);
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

        let body: string;
        if (ahead > 0) {
          pushBranch(workdir.path, headRef);
          body = `${MARKER_TAG} Applied changes for @${p.comment.author}'s comment (${ahead} commit${ahead > 1 ? "s" : ""}).`;
          log.info("pushed changes", { slug, commits: ahead });
        } else {
          body = `${MARKER_TAG} No changes produced for @${p.comment.author}'s comment.`;
          log.info("no changes to push", { slug });
        }

        await ctx.postMarkerComment({ repo, prNumber, body });
      } finally {
        cleanupWorkdir(workdir, ctx.config.keepWorkdirs);
      }
    },
  };
}
