import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentRunInput,
} from "../adapters/agent/agent.interface.js";
import type { Config, ReviewAdversarialMode } from "../config.js";
import type { GitPort, WorkdirHandle } from "../adapters/git/git.interface.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type { StateFactory } from "../adapters/state/state.interface.js";
import { MARKER_TAG } from "../domain/batching.js";
import { log } from "../log.js";
import { buildReviewPrompt } from "./review-prompt.js";
import { findingFingerprint, parseReviewResult } from "../domain/decisions.js";
import type { ReviewFinding, ReviewResult } from "../domain/decisions.js";
import { DraftPullRequestError, ReportMissingError } from "../domain/errors.js";
import { filterPostableFindings } from "../domain/patch-lines.js";
import { decideAdversarialReview } from "../domain/risk.js";
import type { ReviewContext, ReviewTarget } from "../domain/events.js";

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
      taskId: `review:${target.repo.owner}/${target.repo.repo}:pr:${target.prNumber}`,
      token: config.githubToken,
      cloneUrlOverride: options.cloneUrlOverride,
    });
    const primaryReportPath = join(runDir, "primary-report.json");
    const primaryReview = await runReviewAgent({
      git,
      agent,
      workdir: workdir.path,
      branch: pr.headRef,
      reportPath: primaryReportPath,
      prompt: buildReviewPrompt(reviewContext, primaryReportPath),
      label: "Primary review",
    });
    const adversarialDecision = decideAdversarialReview(
      options.adversarialMode ?? config.reviewAdversarialMode,
      reviewContext,
      primaryReview,
    );
    const adversarialRan =
      adversarialDecision.run && options.adversarialAgent !== undefined;
    if (adversarialDecision.run && !options.adversarialAgent) {
      log.warn(
        "adversarial review requested but no adversarial agent was provided",
        {
          slug,
          reasons: adversarialDecision.reasons,
        },
      );
    }
    const adversarialReportPath = join(runDir, "adversarial-report.json");
    const review = adversarialRan
      ? await runReviewAgent({
          git,
          agent: options.adversarialAgent!,
          workdir: workdir.path,
          branch: pr.headRef,
          reportPath: adversarialReportPath,
          prompt: buildReviewPrompt(reviewContext, adversarialReportPath, {
            role: "adversarial",
            primaryReview,
            includePatches: false,
          }),
          label: "Adversarial review",
        })
      : primaryReview;
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

    if (post) {
      repoState.recordReviewRun({
        prNumber: target.prNumber,
        postedFindingKeys: postableFindings.map(findingFingerprint),
        entry: {
          reviewedAt: new Date().toISOString(),
          agent: adversarialRan
            ? `${agent.name}->${options.adversarialAgent!.name}`
            : agent.name,
          findingCount: review.findings.length,
          postedFindingCount: postableFindings.length,
          dryRun: false,
          summary: review.summary,
        },
      });
    }

    return {
      target,
      dryRun: !post,
      review,
      newFindings: postableFindings,
      skippedDuplicateFindings,
      skippedUnpostableFindings,
      adversarialRan,
      adversarialReasons: adversarialDecision.reasons,
    };
  } finally {
    if (workdir) git.cleanupWorkdir(workdir, config.keepWorkdirs);
    if (!config.keepWorkdirs) rmSync(runDir, { recursive: true, force: true });
  }
}

function buildMissingReportPrompt(reportPath: string): string {
  return `Your review report at ${reportPath} is missing. Write it now following the pr-reviewer skill's output schema. Change nothing else.`;
}

async function runReviewAgent(args: {
  git: GitPort;
  agent: AgentAdapter;
  workdir: string;
  branch: string;
  prompt: string;
  reportPath: string;
  label: string;
}): Promise<ReviewResult> {
  const { git, reportPath, label } = args;
  // A kept run dir from an earlier attempt must not satisfy this run's report.
  rmSync(reportPath, { force: true });
  const launch = async (prompt: string): Promise<string> => {
    const result = await runAgent(args.agent, {
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
        `${label} agent modified files during review-only mode; refusing to post.`,
      );
    }
    return result.stderr;
  };

  let stderr = await launch(args.prompt);
  if (!existsSync(reportPath)) {
    log.warn("review report missing, relaunching once", { reportPath, label });
    stderr = await launch(buildMissingReportPrompt(reportPath));
    if (!existsSync(reportPath)) throw new ReportMissingError(reportPath);
  }
  try {
    return parseReviewResult(readFileSync(reportPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${label.toLowerCase()} agent output: ${String(err)}. stderr tail: ${stderr.slice(-1000)}`,
      { cause: err },
    );
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

function formatFindingComment(finding: ReviewFinding): string {
  return `${MARKER_TAG}\n**${finding.severity}:** ${finding.body}`;
}
