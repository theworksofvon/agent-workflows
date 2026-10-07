import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../adapters/agent/agent.interface.js";
import type { Config, ReviewAdversarialMode } from "../config.js";
import type { GitPort, WorkdirHandle } from "../adapters/git/git.interface.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type { StateFactory } from "../adapters/state/state.interface.js";
import { log } from "../log.js";
import { buildReviewPrompt } from "./review-prompt.js";
import {
  MARKER_TAG,
  findingFingerprint,
  parseReviewResult,
} from "../domain/decisions.js";
import type { ReviewFinding, ReviewResult } from "../domain/decisions.js";
import { DraftPullRequestError, ReportMissingError } from "../domain/errors.js";
import { filterPostableFindings } from "../domain/patch-lines.js";
import { decideAdversarialReview } from "../domain/risk.js";
import { errorMessage } from "../domain/util.js";
import type { ReviewContext, ReviewTarget } from "../domain/pull-request.js";

export interface ReviewOptions {
  config: Config;
  github: Pick<
    GitHubPort,
    "getPullRequest" | "listPullRequestFiles" | "createPullRequestReview"
  >;
  git: GitPort;
  state: StateFactory;
  agent: AgentAdapter;
  adversarialAgent?: AgentAdapter;
  adversarialMode?: ReviewAdversarialMode;
  target: ReviewTarget;
  post: boolean;
  /** Clones and fetches the PR; GITHUB_TOKEN or gh's active account. */
  token: string;
  cloneUrlOverride?: string;
}

export interface ReviewRunResult {
  target: ReviewTarget;
  dryRun: boolean;
  review: ReviewResult;
  newFindings: ReviewFinding[];
  skippedDuplicateFindings: number;
  skippedUnpostableFindings: number;
  adversarialRan: boolean;
  adversarialReasons: string[];
}

/**
 * Review a PR read-only: the agent writes its findings to a report file in the
 * run dir; this function owns the checkout, dedup, diff filtering, and posting.
 */
export async function reviewPullRequest(
  options: ReviewOptions,
): Promise<ReviewRunResult> {
  const { config, github, git, agent, target, post } = options;
  const slug = `${target.repo.owner}/${target.repo.repo}#${target.prNumber}`;
  log.info("starting pr review", { slug, agent: agent.name, post });

  const pr = await github.getPullRequest(target.repo, target.prNumber);
  if (pr.draft) throw new DraftPullRequestError(slug);

  const files = await github.listPullRequestFiles(target.repo, target.prNumber);
  const reviewContext: ReviewContext = {
    repo: target.repo,
    prNumber: target.prNumber,
    title: pr.title,
    body: pr.body,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    files,
  };

  const runDir = join(
    config.stateDir,
    "runs",
    `review_${target.repo.owner}_${target.repo.repo}_${target.prNumber}`,
  );
  mkdirSync(runDir, { recursive: true });
  let workdir: WorkdirHandle | undefined;
  try {
    workdir = git.prepareWorkdir({
      stateDir: config.stateDir,
      repo: target.repo,
      branch: pr.headRef,
      baseBranch: pr.baseRef,
      taskId: `review:${target.repo.owner}/${target.repo.repo}:pr:${target.prNumber}`,
      token: options.token,
      cloneUrlOverride: options.cloneUrlOverride,
    });
    const passes = await runReviewPasses({
      git,
      ctx: reviewContext,
      workdir: workdir.path,
      runDir,
      agent,
      adversarialAgent: options.adversarialAgent,
      mode: options.adversarialMode ?? config.reviewAdversarialMode,
    });
    const { review, adversarialRan } = passes;
    const repoState = options.state(target.repo);
    const postedKeys = new Set(
      repoState.getPostedReviewFindingKeys(target.prNumber),
    );
    const newFindings = review.findings.filter(
      (finding) => !postedKeys.has(findingFingerprint(finding)),
    );
    const skippedDuplicateFindings =
      review.findings.length - newFindings.length;
    const postableFindings = post
      ? filterPostableFindings(newFindings, files)
      : newFindings;
    const skippedUnpostableFindings =
      newFindings.length - postableFindings.length;

    if (post && skippedUnpostableFindings > 0) {
      log.warn("skipping unpostable review findings", {
        slug,
        skippedUnpostableFindings,
      });
    }

    if (post && postableFindings.length > 0) {
      await github.createPullRequestReview({
        repo: target.repo,
        prNumber: target.prNumber,
        body: `${MARKER_TAG} ${review.summary}`,
        comments: postableFindings.map((finding) => ({
          path: finding.path,
          line: finding.line,
          body: formatFindingComment(finding),
        })),
      });
      log.info("posted pr review", {
        slug,
        findings: postableFindings.length,
        skippedDuplicateFindings,
        skippedUnpostableFindings,
      });
    } else if (post) {
      log.info("no new review findings to post", {
        slug,
        skippedDuplicateFindings,
        skippedUnpostableFindings,
      });
    }

    if (post)
      repoState.recordPostedFindings(
        target.prNumber,
        postableFindings.map(findingFingerprint),
      );

    return {
      target,
      dryRun: !post,
      review,
      newFindings: postableFindings,
      skippedDuplicateFindings,
      skippedUnpostableFindings,
      adversarialRan,
      adversarialReasons: passes.reasons,
    };
  } finally {
    if (workdir) git.cleanupWorkdir(workdir, config.keepWorkdirs);
    if (!config.keepWorkdirs) rmSync(runDir, { recursive: true, force: true });
  }
}

export interface ReviewPassesArgs {
  git: GitPort;
  ctx: ReviewContext;
  workdir: string;
  runDir: string;
  agent: AgentAdapter;
  adversarialAgent: AgentAdapter | undefined;
  mode: ReviewAdversarialMode;
  /** Runs the adversarial pass whatever the mode decides. */
  force?: boolean;
  includePatches?: boolean;
  /** Returns the primary review with the error instead of throwing. */
  keepPrimaryOnFailure?: boolean;
}

export interface ReviewPasses {
  review: ReviewResult;
  adversarialRan: boolean;
  reasons: string[];
  /** Why a kept-primary adversarial pass failed; null when it did not. */
  adversarialError: string | null;
}

/**
 * Runs the primary review, then the adversarial review when the mode or
 * `force` asks for it. Both read the same worktree: the primary passed the
 * read-only check, so the checkout is still clean when the second starts.
 */
export async function runReviewPasses(
  args: ReviewPassesArgs,
): Promise<ReviewPasses> {
  const { ctx, runDir } = args;
  const base = { git: args.git, workdir: args.workdir, branch: ctx.headRef };
  const primaryPath = join(runDir, "primary-report.json");
  const primary = await runReviewAgent({
    ...base,
    agent: args.agent,
    reportPath: primaryPath,
    prompt: buildReviewPrompt(ctx, primaryPath, {
      includePatches: args.includePatches,
    }),
    label: "Primary review",
  });
  const { run, reasons } = decideAdversarialReview(args.mode, ctx, primary);
  const skipped = { review: primary, adversarialRan: false, reasons };
  if (!run && !args.force) return { ...skipped, adversarialError: null };
  if (!args.adversarialAgent) {
    log.warn(
      "adversarial review requested but no adversarial agent was provided",
      { pr: `${ctx.repo.owner}/${ctx.repo.repo}#${ctx.prNumber}`, reasons },
    );
    return { ...skipped, adversarialError: null };
  }
  const adversarialPath = join(runDir, "adversarial-report.json");
  try {
    const review = await runReviewAgent({
      ...base,
      agent: args.adversarialAgent,
      reportPath: adversarialPath,
      prompt: buildReviewPrompt(ctx, adversarialPath, {
        role: "adversarial",
        primaryReview: primary,
        includePatches: false,
      }),
      label: "Adversarial review",
    });
    return { review, adversarialRan: true, reasons, adversarialError: null };
  } catch (err) {
    if (!args.keepPrimaryOnFailure) throw err;
    log.warn("adversarial review failed; keeping the primary review", {
      error: errorMessage(err),
    });
    return { ...skipped, adversarialError: errorMessage(err) };
  }
}

function buildMissingReportPrompt(reportPath: string): string {
  return `Your review report at ${reportPath} is missing. Write it now following the pr-reviewer skill's output schema. Change nothing else.`;
}

export interface ReportAgentArgs {
  git: GitPort;
  agent: AgentAdapter;
  workdir: string;
  branch: string;
  prompt: string;
  reportPath: string;
  label: string;
}

/** Runs a read-only review agent and parses its report with the pr-reviewer schema. */
export function runReviewAgent(args: ReportAgentArgs): Promise<ReviewResult> {
  return runReportAgent({
    ...args,
    missingPrompt: buildMissingReportPrompt(args.reportPath),
    parse: parseReviewResult,
  });
}

/**
 * Runs a read-only agent that must write a report file: relaunches once with
 * `missingPrompt` if the report is absent, refuses the run if the agent
 * modified the checkout, and parses the report with `parse`.
 */
export async function runReportAgent<T>(
  args: ReportAgentArgs & {
    missingPrompt: string;
    parse: (text: string) => T;
  },
): Promise<T> {
  const { git, reportPath, label } = args;
  // A kept run dir from an earlier attempt must not satisfy this run's report.
  rmSync(reportPath, { force: true });
  const launch = async (prompt: string): Promise<string> => {
    const result = await args.agent.run({
      workdir: args.workdir,
      branch: args.branch,
      prompt,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${label} agent exited ${result.exitCode}. stderr tail: ${result.stderr.slice(-1000)} stdout tail: ${result.stdout.slice(-1000)}`,
      );
    }
    if (git.hasUncommittedChanges(args.workdir)) {
      throw new Error(
        `${label} agent modified files during review-only mode; refusing its report.`,
      );
    }
    return result.stderr;
  };

  let stderr = await launch(args.prompt);
  if (!existsSync(reportPath)) {
    log.warn("report missing, relaunching once", { reportPath, label });
    stderr = await launch(args.missingPrompt);
    if (!existsSync(reportPath)) throw new ReportMissingError(reportPath);
  }
  try {
    return args.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${label.toLowerCase()} agent output: ${String(err)}. stderr tail: ${stderr.slice(-1000)}`,
      { cause: err },
    );
  }
}

function formatFindingComment(finding: ReviewFinding): string {
  return `${MARKER_TAG}\n**${finding.severity}:** ${finding.body}`;
}
