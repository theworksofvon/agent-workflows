import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { BatchHistory, Comment, CommentBatch } from "../domain/events.js";
import type { AgentAdapter } from "../adapters/agent/agent.interface.js";
import type { GitPort, WorkdirHandle } from "../adapters/git/git.interface.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type { StateFactory } from "../adapters/state/state.interface.js";
import { MARKER_TAG, isRetryableAgentFailure } from "../domain/batching.js";
import {
  countDecisions,
  parseAgentReport,
  type AgentReport,
} from "../domain/decisions.js";
import { ReportMissingError } from "../domain/errors.js";
import { log } from "../log.js";

export interface FeedbackPorts {
  git: GitPort;
  github: Pick<GitHubPort, "createComment" | "replyToReviewComment">;
  state: StateFactory;
  agent: AgentAdapter;
  config: Config;
  now?: () => number;
  fs?: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
    readFileSync: typeof readFileSync;
    existsSync: typeof existsSync;
    rmSync: typeof rmSync;
  };
}

export type FeedbackOutcome =
  | { kind: "pushed"; commits: number; report: AgentReport }
  | { kind: "no-changes"; report: AgentReport }
  | { kind: "no-report" }
  | { kind: "lease-rejected"; report: AgentReport }
  | { kind: "retry-scheduled"; retryAfterMs: number };

export interface FeedbackPacket {
  repo: string;
  prNumber: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  comments: Array<{
    key: string;
    author: string;
    kind: Comment["kind"];
    path?: string;
    line?: number | null;
    diffHunk?: string;
    body: string;
    createdAt: string;
  }>;
  history: Array<{ handledAt: string; summary: string }>;
  reportPath: string;
}

const nodeFs = { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync };

/**
 * PR comment batch → packet → agent → report → deterministic tail.
 *
 * The agent owns judgment and writes a mandatory JSON report; this function
 * owns everything else: committing leftovers, pushing with a lease, replying
 * on threads the agent declined, posting the summary, and marking the batch
 * processed so it never loops.
 */
export async function handleFeedback(
  batch: CommentBatch,
  ports: FeedbackPorts,
): Promise<FeedbackOutcome> {
  const { config, agent, git, github } = ports;
  const fs = ports.fs ?? nodeFs;
  const now = ports.now ?? Date.now;
  const { repo, prNumber, headRef } = batch;
  const slug = `${repo.owner}/${repo.repo}#${prNumber}`;
  log.info("handling pr_comment batch", {
    slug,
    batchId: batch.batchId,
    comments: batch.comments.length,
  });

  const safeTaskId = batch.batchId.replace(/[^a-z0-9-]/gi, "_");
  const runDir = join(config.stateDir, "runs", safeTaskId);
  const packetPath = join(runDir, "packet.json");
  const reportPath = join(runDir, "report.json");
  fs.mkdirSync(runDir, { recursive: true });
  // A kept run dir from an earlier attempt must not satisfy this run's report.
  fs.rmSync(reportPath, { force: true });

  const repoState = ports.state(repo);
  const history = repoState.getRecentPrHistory(
    prNumber,
    config.prContextHistoryLimit,
  );
  fs.writeFileSync(
    packetPath,
    JSON.stringify(buildPacket(batch, history, reportPath), null, 2),
  );

  const workdir = git.prepareWorkdir({
    stateDir: config.stateDir,
    repo,
    branch: headRef,
    taskId: safeTaskId,
    token: config.githubToken,
  });

  try {
    const result = await runAgent(agent, {
      workdir: workdir.path,
      branch: headRef,
      prompt: buildLaunchPrompt(packetPath, reportPath),
    });

    if (result.exitCode !== 0) {
      const retryable = isRetryableAgentFailure(
        result.stderr + "\n" + result.stdout,
      );
      log.warn("agent exited non-zero", {
        slug,
        exitCode: result.exitCode,
        retryable,
      });
      if (retryable && batch.attempts < config.agentMaxAttempts) {
        const retryAfterMs = now() + config.agentRetryDelaySec * 1000;
        repoState.pauseBatchForRetry({
          batch,
          retryAfterMs,
          error: result.stderr.slice(-1000) || result.stdout.slice(-1000),
        });
        log.warn("paused batch for retry", {
          slug,
          batchId: batch.batchId,
          attempts: batch.attempts,
          retryAfter: new Date(retryAfterMs).toISOString(),
        });
        return { kind: "retry-scheduled", retryAfterMs };
      }
    }

    if (!fs.existsSync(reportPath)) {
      log.warn("agent report missing, relaunching once", { slug, reportPath });
      await runAgent(agent, {
        workdir: workdir.path,
        branch: headRef,
        prompt: buildMissingReportPrompt(reportPath),
      });
    }
    const report = readReport(
      fs,
      reportPath,
      batch.comments.map((c) => c.key),
    );

    const record = (summary: string, commitCount: number): void => {
      repoState.recordPrHistory(prNumber, {
        batchId: batch.batchId,
        handledAt: new Date(now()).toISOString(),
        agent: agent.name,
        exitCode: result.exitCode,
        commitCount,
        commentKeys: batch.comments.map((c) => c.key),
        summary,
      });
      repoState.markBatchCompleted(batch);
    };

    if (report === undefined) {
      await github.createComment(
        repo,
        prNumber,
        `${MARKER_TAG} Agent produced no usable report for ${describeBatch(batch)}; batch not applied.`,
      );
      record("no report", 0);
      return { kind: "no-report" };
    }

    if (
      git.commitUncommittedChanges(
        workdir.path,
        `Address PR #${prNumber} review comments`,
      )
    ) {
      log.info("orchestrator committed leftover agent changes", { slug });
    }
    const ahead = git.commitsAhead(workdir.path, headRef);

    if (ahead > 0 && !pushWithLease(git, workdir, headRef, slug)) {
      await github.createComment(
        repo,
        prNumber,
        `${MARKER_TAG} Branch moved during the run; ${ahead} commit(s) discarded. ${report.summary}`,
      );
      record(report.summary, 0);
      return { kind: "lease-rejected", report };
    }

    const notAddressed = await replyToDeclined(batch, report, github);
    const counts = countDecisions(report);
    const sections = [
      `${MARKER_TAG} ${report.summary}`,
      `${ahead} commit(s) pushed. Addressed ${counts.addressed}, skipped ${counts.skipped}, needs a human ${counts.needs_human}.`,
    ];
    if (notAddressed.length > 0)
      sections.push(`Not addressed:\n${notAddressed.join("\n")}`);
    await github.createComment(repo, prNumber, sections.join("\n\n"));
    record(report.summary, ahead);
    return ahead > 0
      ? { kind: "pushed", commits: ahead, report }
      : { kind: "no-changes", report };
  } finally {
    git.cleanupWorkdir(workdir, config.keepWorkdirs);
    if (!config.keepWorkdirs)
      fs.rmSync(runDir, { recursive: true, force: true });
  }
}

export function buildPacket(
  batch: CommentBatch,
  history: BatchHistory[],
  reportPath: string,
): FeedbackPacket {
  return {
    repo: `${batch.repo.owner}/${batch.repo.repo}`,
    prNumber: batch.prNumber,
    title: batch.prTitle,
    body: batch.prBody,
    headRef: batch.headRef,
    baseRef: batch.baseRef,
    comments: batch.comments.map((c) => ({
      key: c.key,
      author: c.author,
      kind: c.kind,
      ...(c.review
        ? {
            path: c.review.path,
            line: c.review.line,
            diffHunk: c.review.diffHunk,
          }
        : {}),
      body: c.body,
      createdAt: c.createdAt,
    })),
    history: history.map((h) => ({
      handledAt: h.handledAt,
      summary: h.summary,
    })),
    reportPath,
  };
}

export function buildLaunchPrompt(
  packetPath: string,
  reportPath: string,
): string {
  return [
    "You are handling pull request feedback inside an isolated git worktree for the PR branch.",
    `Read the event packet at ${packetPath}.`,
    "Use the pr-feedback skill to decide and act on each comment.",
    `Before you exit, write your report to ${reportPath}. This report is mandatory.`,
    "Do not push. Commit your changes; the orchestrator pushes.",
  ].join("\n");
}

function buildMissingReportPrompt(reportPath: string): string {
  return `Your report at ${reportPath} is missing. Write it now following the pr-feedback skill's report schema. Change nothing else.`;
}

/** Returns false when the remote branch moved and the lease rejected the push. */
function pushWithLease(
  git: GitPort,
  workdir: WorkdirHandle,
  branch: string,
  slug: string,
): boolean {
  try {
    git.pushBranch(workdir.path, branch, workdir.baseSha);
  } catch (err) {
    log.warn("push rejected by lease", { slug, error: String(err) });
    return false;
  }
  log.info("pushed changes", { slug, branch });
  return true;
}

/** Any unreadable or invalid report is treated as no report at all. */
function readReport(
  fs: NonNullable<FeedbackPorts["fs"]>,
  reportPath: string,
  expectedKeys: string[],
): AgentReport | undefined {
  if (!fs.existsSync(reportPath)) {
    log.warn(new ReportMissingError(reportPath).message);
    return undefined;
  }
  try {
    return parseAgentReport(fs.readFileSync(reportPath, "utf8"), expectedKeys);
  } catch (err) {
    log.warn("agent report unusable", { reportPath, error: String(err) });
    return undefined;
  }
}

/**
 * Inline review threads get a direct reply; conversation-level comments have
 * no thread to reply on, so they are returned as summary lines instead.
 */
async function replyToDeclined(
  batch: CommentBatch,
  report: AgentReport,
  github: FeedbackPorts["github"],
): Promise<string[]> {
  const byKey = new Map(batch.comments.map((c) => [c.key, c]));
  const lines: string[] = [];
  for (const decision of report.comments) {
    if (decision.decision === "addressed") continue;
    const comment = byKey.get(decision.key)!;
    const label = decision.decision === "skipped" ? "Skipped" : "Needs a human";
    if (comment.kind === "review") {
      await github.replyToReviewComment(
        batch.repo,
        batch.prNumber,
        comment.id,
        `${MARKER_TAG} **${label}:** ${decision.reason}`,
      );
    } else {
      lines.push(`- @${comment.author}: ${label}: ${decision.reason}`);
    }
  }
  return lines;
}

function describeBatch(batch: CommentBatch): string {
  const authors = [...new Set(batch.comments.map((c) => `@${c.author}`))];
  const count = batch.comments.length;
  return `${authors.join(", ")}'s ${count} comment${count === 1 ? "" : "s"}`;
}

async function runAgent(
  agent: AgentAdapter,
  input: { workdir: string; branch: string; prompt: string },
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
