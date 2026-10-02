import type { Config, RepoSpec } from "../config.js";
import type { CommentBatch } from "../domain/events.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import type { StateFactory } from "../adapters/state/state.interface.js";
import { commentKey, type IngestPolicy } from "../domain/batching.js";
import { ingestComment } from "./intake.js";
import { log } from "../log.js";

export type GitHubPollingClient = Pick<
  GitHubPort,
  "listOpenPRs" | "listIssueComments" | "listReviewComments"
>;

/**
 * Polls configured repos for new PR comments (both conversation and inline
 * review comments) and returns the batches that became ready. Every comment
 * goes through intake, which filters it and advances the per-PR cursors.
 */
export async function pollRepos(args: {
  config: Config;
  client: GitHubPollingClient;
  state: StateFactory;
}): Promise<CommentBatch[]> {
  const { config, client } = args;
  const policy: IngestPolicy = {
    allowedAuthors: config.allowedAuthors,
    agentSelfUser: config.agentSelfUser,
  };

  async function pollRepo(repo: RepoSpec): Promise<CommentBatch[]> {
    const now = Date.now();
    const state = args.state(repo);
    const firstPoll = !state.isPollingInitialized();
    const skipExisting = firstPoll && !config.processExistingCommentsOnFirstRun;
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
      if (skipExisting) {
        // A fresh state file must not replay history: just move the cursor.
        state.setIssueCommentCursor(
          pr.number,
          issueComments.reduce((m, c) => Math.max(m, c.id), lastIssue),
        );
      } else {
        for (const c of issueComments) {
          if (c.id <= lastIssue) continue;
          ingestComment({
            state,
            pr,
            now,
            policy,
            comment: {
              key: commentKey(repo, pr.number, "issue", c.id),
              id: c.id,
              kind: "issue",
              author: c.author,
              body: c.body,
              createdAt: c.createdAt,
            },
          });
        }
      }

      // --- inline review comments ---
      const lastReview = state.getReviewCommentCursor(pr.number);
      const reviewComments = await client.listReviewComments(repo, pr.number);
      if (skipExisting) {
        state.setReviewCommentCursor(
          pr.number,
          reviewComments.reduce((m, c) => Math.max(m, c.id), lastReview),
        );
      } else {
        for (const c of reviewComments) {
          if (c.id <= lastReview) continue;
          ingestComment({
            state,
            pr,
            now,
            policy,
            comment: {
              key: commentKey(repo, pr.number, "review", c.id),
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
      }
    }

    state.markPollingInitialized();

    return state.takeReadyCommentBatches(now, {
      quietWindowMs: config.commentBatchWindowSec * 1000,
      minComments: config.commentBatchMinComments,
      maxWaitMs: config.commentBatchMaxWaitSec * 1000,
    });
  }

  const all: CommentBatch[] = [];
  for (const repo of config.repos) {
    try {
      const batches = await pollRepo(repo);
      if (batches.length > 0) {
        log.info("poll found new comments", {
          repo: `${repo.owner}/${repo.repo}`,
          count: batches.length,
        });
      }
      all.push(...batches);
    } catch (err) {
      log.error("poll failed for repo", {
        repo: `${repo.owner}/${repo.repo}`,
        error: String(err),
      });
    }
  }
  return all;
}
