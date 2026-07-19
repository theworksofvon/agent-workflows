import type { Source, Event } from "../sources/types.js";
import type { Config, RepoSpec } from "../config.js";
import type { GitHubClient } from "./client.js";
import { MARKER_TAG } from "./client.js";
import { GitHubRepoStateStore } from "./state.js";
import { log } from "../log.js";

/** Payload shape the pr_comment workflow expects. */
export interface PRCommentItem {
  key: string;
  id: number;
  kind: "issue" | "review";
  author: string;
  body: string;
  createdAt: string;
  reviewId?: number | null;
  review?: {
    path: string;
    line: number | null;
    diffHunk: string;
  };
}

export interface PRCommentBatchHistory {
  batchId: string;
  handledAt: string;
  agent: string;
  exitCode: number;
  commitCount: number;
  commentKeys: string[];
  summary: string;
}

export interface PRCommentPayload {
  repo: RepoSpec;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  headRef: string;
  baseRef: string;
  batchId: string;
  groupKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  comments: PRCommentItem[];
}

/**
 * Polls configured repos for new PR comments (both conversation and inline
 * review comments). Owns per-PR cursors in repo-scoped state. Filters out the
 * daemon's own comments to prevent feedback loops.
 */
export function githubPoller(args: {
  config: Config;
  client: GitHubClient;
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

  function commentKey(repo: RepoSpec, prNumber: number, kind: "issue" | "review", id: number): string {
    return `${repo.owner}/${repo.repo}#${prNumber}:${kind}:${id}`;
  }

  async function pollRepo(repo: RepoSpec): Promise<Event[]> {
    const events: Event[] = [];
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
      const maxIssue = issueComments.reduce((m, c) => Math.max(m, c.id), lastIssue);
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
            review: { path: c.path, line: c.line ?? c.originalLine, diffHunk: c.diffHunk },
          },
        });
      }
      const maxReview = reviewComments.reduce((m, c) => Math.max(m, c.id), lastReview);
      state.setReviewCommentCursor(pr.number, maxReview);
    }

    state.markPollingInitialized();

    const windowMs = config.commentBatchWindowSec * 1000;
    for (const payload of state.takeReadyCommentBatches(now, windowMs)) {
      events.push({
        kind: "pr_comment",
        id: payload.batchId,
        payload: payload satisfies PRCommentPayload,
      });
    }
    return events;
  }

  return {
    name: "github-pr-comments",
    async poll() {
      const all: Event[] = [];
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
