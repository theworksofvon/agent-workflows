import type { Config, RepoSpec } from "../config.js";
import type { CommentBatch } from "../domain/events.js";
import type { GitHubClient } from "../adapters/github/octokit.js";
import { MARKER_TAG } from "../adapters/github/octokit.js";
import { GitHubRepoStateStore } from "../adapters/state/json-file.js";
import { log } from "../log.js";

export interface CommentBatchEvent {
  kind: "pr_comment";
  /** Stable id for dedup/logging. */
  id: string;
  payload: CommentBatch;
}

/** Where comment batches come from. Sources own their own cursor. */
export interface Source {
  /** Human-readable name for logs. */
  readonly name: string;
  /** Return batches that became ready since the last poll. */
  poll(): Promise<CommentBatchEvent[]>;
}

export type GitHubPollingClient = Pick<
  GitHubClient,
  "listOpenPRs" | "listIssueComments" | "listReviewComments"
>;

/**
 * Polls configured repos for new PR comments (both conversation and inline
 * review comments). Owns per-PR cursors in repo-scoped state. Filters out the
 * daemon's own comments to prevent feedback loops.
 */
export function githubPoller(args: {
  config: Config;
  client: GitHubPollingClient;
}): Source {
  const { config, client } = args;

  /** True if a comment was authored by this daemon or tagged as its output. */
  function isSelf(body: string, author: string): boolean {
    if (body.includes(MARKER_TAG)) return true;
    if (!config.agentSelfUser) return false;
    return author.toLowerCase() === config.agentSelfUser.toLowerCase();
  }

  function isBotAuthor(author: string): boolean {
    return author.toLowerCase().endsWith("[bot]");
  }

  function commentKey(
    repo: RepoSpec,
    prNumber: number,
    kind: "issue" | "review",
    id: number,
  ): string {
    return `${repo.owner}/${repo.repo}#${prNumber}:${kind}:${id}`;
  }

  async function pollRepo(repo: RepoSpec): Promise<CommentBatchEvent[]> {
    const events: CommentBatchEvent[] = [];
    const now = Date.now();
    const state = GitHubRepoStateStore.fromConfig(config, repo);
    const firstPoll = !state.isPollingInitialized();
    const prs = await client.listOpenPRs(repo);

    for (const pr of prs) {
      if (pr.draft) {
        log.debug("skipping draft pr", {
          repo: `${repo.owner}/${repo.repo}`,
          prNumber: pr.number,
        });
        continue;
      }

      // --- conversation comments ---
      const lastIssue = state.getIssueCommentCursor(pr.number);
      const issueComments = await client.listIssueComments(repo, pr.number);
      for (const c of issueComments) {
        if (c.id <= lastIssue) continue;
        if (firstPoll && !config.processExistingCommentsOnFirstRun) continue;
        if (isSelf(c.body, c.author)) continue;
        if (isBotAuthor(c.author)) continue;
        const key = commentKey(repo, pr.number, "issue", c.id);
        if (state.hasProcessedComment(key)) continue;
        state.addPendingComment({
          pr,
          groupKey: `pr:${pr.number}:conversation`,
          now,
          comment: {
            key,
            id: c.id,
            kind: "issue",
            author: c.author,
            body: c.body,
            createdAt: c.createdAt,
          },
        });
      }
      const maxIssue = issueComments.reduce(
        (m, c) => Math.max(m, c.id),
        lastIssue,
      );
      state.setIssueCommentCursor(pr.number, maxIssue);

      // --- inline review comments ---
      const lastReview = state.getReviewCommentCursor(pr.number);
      const reviewComments = await client.listReviewComments(repo, pr.number);
      for (const c of reviewComments) {
        if (c.id <= lastReview) continue;
        if (firstPoll && !config.processExistingCommentsOnFirstRun) continue;
        if (isSelf(c.body, c.author)) continue;
        const key = commentKey(repo, pr.number, "review", c.id);
        if (state.hasProcessedComment(key)) continue;
        state.addPendingComment({
          pr,
          groupKey: c.reviewId
            ? `pr:${pr.number}:review:${c.reviewId}`
            : `pr:${pr.number}:review-comments`,
          now,
          comment: {
            key,
            id: c.id,
            kind: "review",
            author: c.author,
            body: c.body,
            createdAt: c.createdAt,
            reviewId: c.reviewId,
            review: {
              path: c.path,
              line: c.line ?? c.originalLine,
              diffHunk: c.diffHunk,
            },
          },
        });
      }
      const maxReview = reviewComments.reduce(
        (m, c) => Math.max(m, c.id),
        lastReview,
      );
      state.setReviewCommentCursor(pr.number, maxReview);
    }

    state.markPollingInitialized();

    for (const payload of state.takeReadyCommentBatches(now, {
      quietWindowMs: config.commentBatchWindowSec * 1000,
      minComments: config.commentBatchMinComments,
      maxWaitMs: config.commentBatchMaxWaitSec * 1000,
    })) {
      events.push({
        kind: "pr_comment",
        id: payload.batchId,
        payload: payload satisfies CommentBatch,
      });
    }
    return events;
  }

  return {
    name: "github-pr-comments",
    async poll() {
      const all: CommentBatchEvent[] = [];
      for (const repo of config.repos) {
        try {
          const events = await pollRepo(repo);
          if (events.length > 0) {
            log.info("poll found new comments", {
              repo: `${repo.owner}/${repo.repo}`,
              count: events.length,
            });
          }
          all.push(...events);
        } catch (err) {
          log.error("poll failed for repo", {
            repo: `${repo.owner}/${repo.repo}`,
            error: String(err),
          });
        }
      }
      return all;
    },
  };
}
