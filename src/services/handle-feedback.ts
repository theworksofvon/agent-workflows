import type { Config } from "../config.js";
import type { CommentBatch } from "../domain/events.js";
import type {
  AgentAdapter,
  AgentRunInput,
} from "../adapters/agent/agent.interface.js";
import { GitHubRepoStateStore } from "../adapters/state/json-file.js";
import {
  prepareWorkdir,
  cleanupWorkdir,
  commitUncommittedChanges,
  commitsAhead,
  pushBranch,
} from "../adapters/git/exec.js";
import { buildPrompt } from "./feedback-prompt.js";
import { MARKER_TAG } from "../adapters/github/octokit.js";
import { log } from "../log.js";

/**
 * Bundle of the things feedback handling needs without reaching into
 * globals.
 */
export interface RunCtx {
  config: Config;
  agent: AgentAdapter;
  /** Post a PR comment tagged so the daemon ignores it (loop prevention). */
  postMarkerComment(args: {
    repo: { owner: string; repo: string };
    prNumber: number;
    body: string;
  }): Promise<void>;
}

export interface HandleFeedbackDependencies {
  prepareWorkdir: typeof prepareWorkdir;
  cleanupWorkdir: typeof cleanupWorkdir;
  runAgent: typeof runAgent;
  buildPrompt: typeof buildPrompt;
  commitUncommittedChanges: typeof commitUncommittedChanges;
  commitsAhead: typeof commitsAhead;
  pushBranch: typeof pushBranch;
  now: typeof Date.now;
}

export const defaultHandleFeedbackDependencies: HandleFeedbackDependencies = {
  prepareWorkdir,
  cleanupWorkdir,
  runAgent,
  buildPrompt,
  commitUncommittedChanges,
  commitsAhead,
  pushBranch,
  now: Date.now,
};

/**
 * PR comment batch → coding agent → push.
 *
 * Flow: build context → isolated clone → run agent → count commits →
 * push (or post a "nothing to do" comment) → post marker summary comment.
 */
export async function handleFeedback(
  p: CommentBatch,
  ctx: RunCtx,
  dependencies: HandleFeedbackDependencies = defaultHandleFeedbackDependencies,
): Promise<void> {
  const { repo, prNumber, headRef } = p;
  const slug = `${repo.owner}/${repo.repo}#${prNumber}`;
  log.info("handling pr_comment batch", {
    slug,
    batchId: p.batchId,
    comments: p.comments.length,
  });

  const repoState = GitHubRepoStateStore.fromConfig(ctx.config, repo);
  const history = repoState.getRecentPrHistory(
    prNumber,
    ctx.config.prContextHistoryLimit,
  );
  const prompt = dependencies.buildPrompt(p, history);
  const taskId = p.batchId.replace(/[^a-z0-9-]/gi, "_");

  const workdir = dependencies.prepareWorkdir({
    stateDir: ctx.config.stateDir,
    repo,
    branch: headRef,
    taskId,
    token: ctx.config.githubToken,
  });

  try {
    const result = await dependencies.runAgent(ctx.agent, {
      workdir: workdir.path,
      branch: headRef,
      prompt,
    });

    if (result.exitCode !== 0) {
      log.warn("agent exited non-zero", {
        slug,
        exitCode: result.exitCode,
        retryable: isRetryableAgentFailure(
          result.stderr + "\n" + result.stdout,
        ),
      });
      if (
        isRetryableAgentFailure(result.stderr + "\n" + result.stdout) &&
        p.attempts < ctx.config.agentMaxAttempts
      ) {
        const retryAfterMs =
          dependencies.now() + ctx.config.agentRetryDelaySec * 1000;
        repoState.pauseBatchForRetry({
          batch: p,
          retryAfterMs,
          error: result.stderr.slice(-1000) || result.stdout.slice(-1000),
        });
        log.warn("paused batch for retry", {
          slug,
          batchId: p.batchId,
          attempts: p.attempts,
          retryAfter: new Date(retryAfterMs).toISOString(),
        });
        return;
      }
    }
    const committedLeftovers = dependencies.commitUncommittedChanges(
      workdir.path,
      `Address PR #${prNumber} review comments`,
    );
    if (committedLeftovers) {
      log.info("orchestrator committed leftover agent changes", { slug });
    }

    const authors = [...new Set(p.comments.map((c) => c.author))];
    const authorText =
      authors.length === 1
        ? `@${authors[0]}`
        : authors.map((author) => `@${author}`).join(", ");
    const commentText = `${p.comments.length} comment${p.comments.length === 1 ? "" : "s"}`;
    const ahead = dependencies.commitsAhead(workdir.path, headRef);
    let body: string;
    if (ahead > 0) {
      dependencies.pushBranch(workdir.path, headRef, workdir.baseSha);
      body = `${MARKER_TAG} Applied changes for ${authorText}'s ${commentText} (${ahead} commit${ahead > 1 ? "s" : ""}).`;
      log.info("pushed changes", { slug, commits: ahead });
    } else {
      body = `${MARKER_TAG} No changes produced for ${authorText}'s ${commentText}.`;
      log.info("no changes to push", { slug });
    }

    await ctx.postMarkerComment({ repo, prNumber, body });
    repoState.recordPrHistory(prNumber, {
      batchId: p.batchId,
      handledAt: new Date().toISOString(),
      agent: ctx.agent.name,
      exitCode: result.exitCode,
      commitCount: ahead,
      commentKeys: p.comments.map((c) => c.key),
      summary: summarizeBatch(p, ahead),
    });
    repoState.markBatchCompleted(p);
  } finally {
    dependencies.cleanupWorkdir(workdir, ctx.config.keepWorkdirs);
  }
}

/** Runs the agent in the prepared workdir and returns the result. */
async function runAgent(
  agent: AgentAdapter,
  input: AgentRunInput,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  log.info("running agent", { agent: agent.name, workdir: input.workdir });
  const res = await agent.run(input);
  log.info("agent finished", {
    agent: agent.name,
    exitCode: res.exitCode,
    stdoutTail: res.stdout.slice(-200),
    stderrTail: res.stderr.slice(-500),
  });
  return res;
}

function isRetryableAgentFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return [
    "rate limit",
    "usage limit",
    "quota",
    "too many requests",
    "429",
    "temporarily unavailable",
    "try again later",
    "capacity",
  ].some((needle) => normalized.includes(needle));
}

function summarizeBatch(p: CommentBatch, commitCount: number): string {
  const files = [
    ...new Set(
      p.comments
        .map((comment) => comment.review?.path)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  const authors = [
    ...new Set(p.comments.map((comment) => `@${comment.author}`)),
  ];
  const fileText =
    files.length > 0 ? ` on ${files.slice(0, 5).join(", ")}` : "";
  const moreFiles =
    files.length > 5 ? ` and ${files.length - 5} more file(s)` : "";
  const result =
    commitCount > 0
      ? `produced ${commitCount} commit(s)`
      : "produced no commits";
  return `Handled batch from ${authors.join(", ")} with ${p.comments.length} comment(s)${fileText}${moreFiles}; ${result}`;
}
