import type { AgentAdapter } from "../../agents/types.js";
import type { Config } from "../../config.js";
import type { ReviewAdversarialMode } from "../../config.js";
import type { GitHubClient } from "../../github/client.js";
import { MARKER_TAG } from "../../github/client.js";
import { GitHubRepoStateStore } from "../../github/state.js";
import { log } from "../../log.js";
import { runAgent } from "../../runner/executor.js";
import { cleanupWorkdir, prepareWorkdir } from "../../runner/workdir.js";
import { hasUncommittedChanges } from "../pr-comment/push.js";
import { buildReviewPrompt } from "./context.js";
import { findingFingerprint, parseReviewResult } from "./parser.js";
import { decideAdversarialReview } from "./risk.js";
import type {
  PRReviewTarget,
  PullRequestReviewContext,
  ReviewFinding,
  ReviewResult,
} from "./types.js";

type ReviewGitHubClient = Pick<
  GitHubClient,
  "getPullRequest" | "listPullRequestFiles" | "createPullRequestReview"
>;

export interface RunPullRequestReviewOptions {
  config: Config;
  client: ReviewGitHubClient;
  agent: AgentAdapter;
  adversarialAgent?: AgentAdapter;
  adversarialMode?: ReviewAdversarialMode;
  target: PRReviewTarget;
  post: boolean;
  cloneUrlOverride?: string;
}

export interface PullRequestReviewRunResult {
  target: PRReviewTarget;
  dryRun: boolean;
  review: ReviewResult;
  newFindings: ReviewFinding[];
  skippedDuplicateFindings: number;
  skippedUnpostableFindings: number;
  adversarialRan: boolean;
  adversarialReasons: string[];
}

export class PullRequestReviewWorkflow {
  async run(
    options: RunPullRequestReviewOptions,
  ): Promise<PullRequestReviewRunResult> {
    const { config, client, agent, target, post } = options;
    const slug = `${target.repo.owner}/${target.repo.repo}#${target.prNumber}`;
    log.info("starting pr review", { slug, agent: agent.name, post });

    const pr = await client.getPullRequest(target.repo, target.prNumber);
    if (pr.draft) {
      throw new Error(
        `PR ${slug} is a draft; review mode only runs on ready-for-review PRs.`,
      );
    }

    const files = await client.listPullRequestFiles(
      target.repo,
      target.prNumber,
    );
    const reviewContext: PullRequestReviewContext = {
      repo: target.repo,
      prNumber: target.prNumber,
      title: pr.title,
      body: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      files,
    };

    const workdir = prepareWorkdir({
      stateDir: config.stateDir,
      repo: target.repo,
      branch: pr.headRef,
      taskId: `review:${target.repo.owner}/${target.repo.repo}:pr:${target.prNumber}`,
      token: config.githubToken,
      cloneUrlOverride: options.cloneUrlOverride,
    });

    try {
      const primaryReview = await runReviewAgent({
        agent,
        workdir: workdir.path,
        branch: pr.headRef,
        prompt: buildReviewPrompt(reviewContext),
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
      const review = adversarialRan
        ? await runReviewAgent({
            agent: options.adversarialAgent!,
            workdir: workdir.path,
            branch: pr.headRef,
            prompt: buildReviewPrompt(reviewContext, {
              role: "adversarial",
              primaryReview,
              includePatches: false,
            }),
            label: "Adversarial review",
          })
        : primaryReview;
      const repoState = GitHubRepoStateStore.fromConfig(config, target.repo);
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
        await client.createPullRequestReview({
          ref: target.repo,
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
      cleanupWorkdir(workdir, config.keepWorkdirs);
    }
  }
}

async function runReviewAgent(args: {
  agent: AgentAdapter;
  workdir: string;
  branch: string;
  prompt: string;
  label: string;
}): Promise<ReviewResult> {
  const result = await runAgent(args.agent, {
    workdir: args.workdir,
    branch: args.branch,
    prompt: args.prompt,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.label} agent exited ${result.exitCode}. stderr tail: ${result.stderr.slice(-1000)} stdout tail: ${result.stdout.slice(-1000)}`,
    );
  }
  if (hasUncommittedChanges(args.workdir)) {
    throw new Error(
      `${args.label} agent modified files during review-only mode; refusing to post.`,
    );
  }
  try {
    return parseReviewResult(result.stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse ${args.label.toLowerCase()} agent output: ${String(err)}. stderr tail: ${result.stderr.slice(-1000)} stdout tail: ${result.stdout.slice(-1000)}`,
      { cause: err },
    );
  }
}

function formatFindingComment(finding: ReviewFinding): string {
  return `${MARKER_TAG}\n**${finding.severity}:** ${finding.body}`;
}

function filterPostableFindings(
  findings: ReviewFinding[],
  files: PullRequestReviewContext["files"],
): ReviewFinding[] {
  const postableLines = new Map<string, Set<number>>();
  for (const file of files) {
    postableLines.set(file.path, parseRightSidePatchLines(file.patch));
  }
  return findings.filter(
    (finding) => postableLines.get(finding.path)?.has(finding.line) ?? false,
  );
}

export function parseRightSidePatchLines(patch: string | null): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let rightLine: number | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      rightLine = Number(header[1]);
      continue;
    }
    if (rightLine === null) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      lines.add(rightLine);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("\\")) continue;
    rightLine += 1;
  }

  return lines;
}
