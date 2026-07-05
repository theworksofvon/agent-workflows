import type { AgentAdapter } from "../../agents/types.js";
import type { Config } from "../../config.js";
import type { GitHubClient } from "../../github/client.js";
import { MARKER_TAG } from "../../github/client.js";
import { GitHubRepoStateStore } from "../../github/state.js";
import { log } from "../../log.js";
import { runAgent } from "../../runner/executor.js";
import { cleanupWorkdir, prepareWorkdir } from "../../runner/workdir.js";
import { hasUncommittedChanges } from "../pr-comment/push.js";
import { buildReviewPrompt } from "./context.js";
import { findingFingerprint, parseReviewResult } from "./parser.js";
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
}

export class PullRequestReviewWorkflow {
  async run(options: RunPullRequestReviewOptions): Promise<PullRequestReviewRunResult> {
    const { config, client, agent, target, post } = options;
    const slug = `${target.repo.owner}/${target.repo.repo}#${target.prNumber}`;
    log.info("starting pr review", { slug, agent: agent.name, post });

    const pr = await client.getPullRequest(target.repo, target.prNumber);
    if (pr.draft) {
      throw new Error(`PR ${slug} is a draft; review mode only runs on ready-for-review PRs.`);
    }

    const files = await client.listPullRequestFiles(target.repo, target.prNumber);
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
      const agentResult = await runAgent(agent, {
        workdir: workdir.path,
        branch: pr.headRef,
        prompt: buildReviewPrompt(reviewContext),
      });
      if (agentResult.exitCode !== 0) {
        throw new Error(
          `Review agent exited ${agentResult.exitCode}. stderr tail: ${agentResult.stderr.slice(-1000)} stdout tail: ${agentResult.stdout.slice(-1000)}`,
        );
      }

      if (hasUncommittedChanges(workdir.path)) {
        throw new Error("Review agent modified files during review-only mode; refusing to post.");
      }

      let review: ReviewResult;
      try {
        review = parseReviewResult(agentResult.stdout);
      } catch (err) {
        throw new Error(
          `Failed to parse review agent output: ${String(err)}. stderr tail: ${agentResult.stderr.slice(-1000)} stdout tail: ${agentResult.stdout.slice(-1000)}`,
        );
      }
      const repoState = GitHubRepoStateStore.fromConfig(config, target.repo);
      const postedKeys = new Set(repoState.getPostedReviewFindingKeys(target.prNumber));
      const newFindings = review.findings.filter(
        (finding) => !postedKeys.has(findingFingerprint(finding)),
      );
      const skippedDuplicateFindings = review.findings.length - newFindings.length;

      if (post && newFindings.length > 0) {
        await client.createPullRequestReview({
          ref: target.repo,
          prNumber: target.prNumber,
          body: `${MARKER_TAG} ${review.summary}`,
          comments: newFindings.map((finding) => ({
            path: finding.path,
            line: finding.line,
            body: formatFindingComment(finding),
          })),
        });
        log.info("posted pr review", {
          slug,
          findings: newFindings.length,
          skippedDuplicateFindings,
        });
      } else if (post) {
        log.info("no new review findings to post", {
          slug,
          skippedDuplicateFindings,
        });
      }

      if (post) {
        repoState.recordReviewRun({
          prNumber: target.prNumber,
          postedFindingKeys: newFindings.map(findingFingerprint),
          entry: {
            reviewedAt: new Date().toISOString(),
            agent: agent.name,
            findingCount: review.findings.length,
            postedFindingCount: newFindings.length,
            dryRun: false,
            summary: review.summary,
          },
        });
      }

      return {
        target,
        dryRun: !post,
        review,
        newFindings,
        skippedDuplicateFindings,
      };
    } finally {
      cleanupWorkdir(workdir, config.keepWorkdirs);
    }
  }
}

function formatFindingComment(finding: ReviewFinding): string {
  return `${MARKER_TAG}\n**${finding.severity}:** ${finding.body}`;
}
