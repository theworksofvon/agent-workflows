import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../adapters/agent/agent.interface.js";
import type { GitPort, WorkdirHandle } from "../adapters/git/git.interface.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type {
  PartResult,
  PrSnapshot,
  ReviewSession,
  ReviewSessionStore,
} from "../adapters/state/review-sessions.js";
import type { Config } from "../config.js";
import type { ReviewResult } from "../domain/decisions.js";
import type { ReviewContext } from "../domain/pull-request.js";
import { parseGuide, type Guide } from "../domain/guide.js";
import { heuristicTriage, type Triage } from "../domain/triage.js";
import { log } from "../log.js";
import { buildGuidePrompt } from "./guide-prompt.js";
import { runReportAgent, runReviewPasses } from "./review-pr.js";
import { errorMessage } from "../domain/util.js";
import { ServerStoppedError } from "../domain/errors.js";

export interface GuidedReviewDeps {
  config: Config;
  /** The session's account: its client fetches the PR, its token clones. */
  github: {
    use(login: string): Promise<{
      token: string;
      client: Pick<GitHubPort, "getPullRequestDetail" | "listPullRequestFiles">;
    }>;
  };
  git: GitPort;
  sessions: ReviewSessionStore;
  agent: AgentAdapter;
  adversarialAgent: AgentAdapter;
}

/**
 * The guide writer and the reviewer run at the same time, so a guided run
 * takes 2 of MAX_CONCURRENT_RUNS slots.
 */
export const GUIDED_RUN_SLOTS = 2;

/** Above either limit the reviewer reads the local diff instead of patches. */
const PATCH_FILE_LIMIT = 40;
const PATCH_LINE_LIMIT = 3000;

/**
 * Fetches and triages the PR, then writes the guide and runs the review in
 * parallel. The guide and the review each get a read-only worktree at the
 * snapshot's head commit, so the guide's scratch files cannot fail the
 * review's report; the adversarial pass reuses the review's worktree. Never
 * throws: every failure is recorded on the session.
 */
export async function runGuidedReview(
  sessionId: string,
  deps: GuidedReviewDeps,
): Promise<void> {
  const { config, git, sessions } = deps;
  const runDir = join(config.stateDir, "runs", `guide_${sessionId}`);
  const workdirs: WorkdirHandle[] = [];
  try {
    const session = sessions.get(sessionId);
    if (!session) {
      log.warn("guided review session not found", { sessionId });
      return;
    }
    const { token, client } = await deps.github.use(session.account);
    const { ctx, headSha } = await fetchPullRequest(session, client, deps);
    const triage = heuristicTriage(ctx);
    sessions.update(sessionId, { triage, stage: `Triage: ${triage.depth}` });

    sessions.update(sessionId, {
      status: "preparing",
      stage: "Preparing read-only checkouts",
    });
    const checkout = (role: string): string => {
      const handle = git.prepareWorkdir({
        stateDir: config.stateDir,
        repo: session.repo,
        branch: ctx.headRef,
        baseBranch: ctx.baseRef,
        commit: headSha,
        taskId: `guide:${session.repo.owner}/${session.repo.repo}:pr:${session.prNumber}:${sessionId.slice(0, 8)}:${role}`,
        token,
      });
      workdirs.push(handle);
      return handle.path;
    };
    const guideWorkdir = checkout("guide");
    const reviewWorkdir = checkout("review");
    mkdirSync(runDir, { recursive: true });

    sessions.update(sessionId, {
      status: "analyzing",
      stage: "Writing the guide and reviewing the code",
    });
    const run = { deps, ctx, runDir };
    const guide = settle(() => writeGuide(run, guideWorkdir));
    // With one run slot the two agents take turns instead of running together.
    if (config.maxConcurrentRuns < GUIDED_RUN_SLOTS) await guide;
    const review = settle(() => reviewCode(run, reviewWorkdir, triage));
    recordResult(sessionId, sessions, await guide, await review);
  } catch (err) {
    recordFailure(sessionId, sessions, err);
  } finally {
    cleanup(workdirs, runDir, deps);
  }
}

interface Run {
  deps: GuidedReviewDeps;
  ctx: ReviewContext;
  runDir: string;
}

interface ReviewOutcome {
  value: ReviewResult;
  adversarial: boolean;
  error: string | null;
}

async function fetchPullRequest(
  session: ReviewSession,
  github: Pick<GitHubPort, "getPullRequestDetail" | "listPullRequestFiles">,
  deps: GuidedReviewDeps,
): Promise<{ ctx: ReviewContext; headSha: string }> {
  const { sessions } = deps;
  sessions.update(session.id, {
    status: "triaging",
    stage: "Fetching the pull request",
  });
  const [details, files] = await Promise.all([
    github.getPullRequestDetail(session.repo, session.prNumber),
    github.listPullRequestFiles(session.repo, session.prNumber),
  ]);
  const pr: PrSnapshot = {
    title: details.title,
    body: details.body,
    author: details.author.login,
    authorAvatarUrl: details.author.avatarUrl,
    state: details.state,
    lastCommit: details.lastCommit,
    url: details.url,
    headRef: details.headRef,
    baseRef: details.baseRef,
    headSha: details.headSha,
    files,
  };
  sessions.update(session.id, { pr });
  // The worktree comes from the base repository, which lacks a fork's branch.
  if (details.fromFork)
    throw new Error(
      `${session.repo.owner}/${session.repo.repo}#${session.prNumber} comes from a fork; guided review supports only branches in the same repository.`,
    );
  return {
    ctx: {
      repo: session.repo,
      prNumber: session.prNumber,
      title: pr.title,
      body: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      files,
    },
    headSha: pr.headSha,
  };
}

/**
 * Records the failure on the session. After shutdown the session is already
 * marked interrupted and the store refuses writes, so nothing is recorded.
 */
function recordFailure(
  sessionId: string,
  sessions: ReviewSessionStore,
  err: unknown,
): void {
  let problem = err;
  if (!(problem instanceof ServerStoppedError)) {
    log.warn("guided review failed", { sessionId, error: errorMessage(err) });
    try {
      sessions.update(sessionId, {
        status: "failed",
        stage: "Failed",
        error: errorMessage(err),
      });
      return;
    } catch (recordErr) {
      problem = recordErr;
    }
  }
  if (problem instanceof ServerStoppedError)
    log.info("guided review stopped by shutdown", { sessionId });
  else
    log.error("could not record the guided review failure", {
      sessionId,
      error: errorMessage(problem),
    });
}

function writeGuide(run: Run, workdir: string): Promise<Guide> {
  const reportPath = join(run.runDir, "guide.json");
  const prompt = buildGuidePrompt(run.ctx, reportPath);
  return runReportAgent({
    git: run.deps.git,
    agent: run.deps.agent,
    workdir,
    branch: run.ctx.headRef,
    prompt,
    reportPath,
    label: "Guide",
    missingPrompt: `Your guide at ${reportPath} is missing. Write it now, following the instructions below. Change nothing else.\n\n${prompt}`,
    parse: (text) =>
      parseGuide(
        text,
        run.ctx.files.map((file) => file.path),
      ),
  });
}

async function reviewCode(
  run: Run,
  workdir: string,
  triage: Triage,
): Promise<ReviewOutcome> {
  const { deps, ctx } = run;
  const passes = await runReviewPasses({
    git: deps.git,
    ctx,
    workdir,
    runDir: run.runDir,
    agent: deps.agent,
    adversarialAgent: deps.adversarialAgent,
    mode: deps.config.reviewAdversarialMode,
    force: triage.depth === "deep",
    includePatches: isSmall(ctx),
    keepPrimaryOnFailure: true,
  });
  const { adversarialError } = passes;
  return {
    value: passes.review,
    adversarial: passes.adversarialRan,
    error:
      adversarialError && `${adversarialError} (showing the primary review)`,
  };
}

function recordResult(
  sessionId: string,
  sessions: ReviewSessionStore,
  guide: PromiseSettledResult<Guide>,
  review: PromiseSettledResult<ReviewOutcome>,
): void {
  const guidePart: PartResult<Guide> =
    guide.status === "fulfilled"
      ? { value: guide.value, error: null }
      : { value: null, error: errorMessage(guide.reason) };
  const reviewPart =
    review.status === "fulfilled"
      ? review.value
      : { value: null, adversarial: false, error: errorMessage(review.reason) };
  const bothFailed = guidePart.value === null && reviewPart.value === null;
  sessions.update(sessionId, {
    status: bothFailed ? "failed" : "ready",
    stage: bothFailed ? "Failed" : "Ready",
    error: bothFailed
      ? `Guide: ${guidePart.error}; Review: ${reviewPart.error}`
      : null,
    guide: guidePart,
    review: reviewPart,
  });
}

function cleanup(
  workdirs: WorkdirHandle[],
  runDir: string,
  deps: GuidedReviewDeps,
): void {
  const keep = deps.config.keepWorkdirs;
  for (const workdir of workdirs) {
    try {
      deps.git.cleanupWorkdir(workdir, keep);
    } catch (err) {
      log.warn("guided review worktree cleanup failed", {
        path: workdir.path,
        error: errorMessage(err),
      });
    }
  }
  try {
    if (!keep) rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    log.warn("guided review run dir cleanup failed", {
      path: runDir,
      error: errorMessage(err),
    });
  }
}

async function settle<T>(
  fn: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([fn()]);
  return result;
}

function isSmall(ctx: ReviewContext): boolean {
  const lines = ctx.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  return ctx.files.length <= PATCH_FILE_LIMIT && lines <= PATCH_LINE_LIMIT;
}
