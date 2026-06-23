import type { Source, Event } from "../sources/types.js";
import type { Config, RepoSpec } from "../config.js";
import type { Store } from "../store.js";
import type { GitHubClient } from "./client.js";
import { MARKER_TAG } from "./client.js";
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
  comments: PRCommentItem[];
}

interface PendingCommentGroup extends PRCommentPayload {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export const prHistoryKey = (repo: RepoSpec, prNumber: number) =>
  `gh:${repo.owner}/${repo.repo}:pr:${prNumber}:comment-batch-history`;

/**
 * Polls configured repos for new PR comments (both conversation and inline
 * review comments). Owns per-repo cursors in the store. Filters out the
 * daemon's own comments to prevent feedback loops.
 */
export function githubPoller(args: {
  config: Config;
  store: Store;
  client: GitHubClient;
}): Source {
  const { config, store, client } = args;

  const cursorKey = (repo: RepoSpec, kind: string) =>
    `gh:${repo.owner}/${repo.repo}:cursor:${kind}`;
  const pendingKey = (repo: RepoSpec) =>
    `gh:${repo.owner}/${repo.repo}:pending-comment-groups`;
  const processedKey = (repo: RepoSpec) =>
    `gh:${repo.owner}/${repo.repo}:processed-comment-keys`;

  /** True if a comment was authored by this daemon or tagged as its output. */
  function isSelf(body: string, author: string): boolean {
    if (body.includes(MARKER_TAG)) return true;
    return author.toLowerCase() === config.agentSelfUser.toLowerCase();
  }

  function commentKey(repo: RepoSpec, prNumber: number, kind: "issue" | "review", id: number): string {
    return `${repo.owner}/${repo.repo}#${prNumber}:${kind}:${id}`;
  }

  function addPendingComment(args: {
    pending: Record<string, PendingCommentGroup>;
    repo: RepoSpec;
    pr: Awaited<ReturnType<GitHubClient["listOpenPRs"]>>[number];
    groupKey: string;
    comment: PRCommentItem;
    now: number;
  }): void {
    const { pending, repo, pr, groupKey, comment, now } = args;
    const existing = pending[groupKey];
    const comments = existing?.comments ?? [];
    if (comments.some((c) => c.key === comment.key)) return;

    const firstSeenAtMs = existing?.firstSeenAtMs ?? now;
    pending[groupKey] = {
      repo,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      batchId: existing?.batchId ?? `batch:${repo.owner}/${repo.repo}:${groupKey}:${now}`,
      groupKey,
      firstSeenAt: new Date(firstSeenAtMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      firstSeenAtMs,
      lastSeenAtMs: now,
      comments: [...comments, comment].sort((a, b) => {
        const byTime = Number(new Date(a.createdAt)) - Number(new Date(b.createdAt));
        return byTime === 0 ? a.id - b.id : byTime;
      }),
    };
  }

  function pruneProcessed(keys: Set<string>): string[] {
    return [...keys].slice(-2000);
  }

  async function pollRepo(repo: RepoSpec): Promise<Event[]> {
    const events: Event[] = [];
    const now = Date.now();
    const pending = store.get<Record<string, PendingCommentGroup>>(pendingKey(repo), {});
    const processed = new Set(store.get<string[]>(processedKey(repo), []));
    const prs = await client.listOpenPRs(repo);

    for (const pr of prs) {
      // --- conversation comments ---
      const lastIssue = store.get<number>(cursorKey(repo, "issue"), 0);
      const issueComments = await client.listIssueComments(repo, pr.number);
      for (const c of issueComments) {
        if (c.id <= lastIssue) continue;
        if (isSelf(c.body, c.author)) continue;
        const key = commentKey(repo, pr.number, "issue", c.id);
        if (processed.has(key)) continue;
        addPendingComment({
          pending,
          repo,
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
      store.set(cursorKey(repo, "issue"), maxIssue);

      // --- inline review comments ---
      const lastReview = store.get<number>(cursorKey(repo, "review"), 0);
      const reviewComments = await client.listReviewComments(repo, pr.number);
      for (const c of reviewComments) {
        if (c.id <= lastReview) continue;
        if (isSelf(c.body, c.author)) continue;
        const key = commentKey(repo, pr.number, "review", c.id);
        if (processed.has(key)) continue;
        addPendingComment({
          pending,
          repo,
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
      store.set(cursorKey(repo, "review"), maxReview);
    }

    const windowMs = config.commentBatchWindowSec * 1000;
    for (const [groupKey, group] of Object.entries(pending)) {
      if (now - group.lastSeenAtMs < windowMs) continue;
      const payload: PRCommentPayload = {
        repo: group.repo,
        prNumber: group.prNumber,
        prTitle: group.prTitle,
        prBody: group.prBody,
        headRef: group.headRef,
        baseRef: group.baseRef,
        batchId: group.batchId,
        groupKey: group.groupKey,
        firstSeenAt: group.firstSeenAt,
        lastSeenAt: group.lastSeenAt,
        comments: group.comments,
      };
      for (const comment of group.comments) {
        processed.add(comment.key);
      }
      delete pending[groupKey];
      events.push({
        kind: "pr_comment",
        id: group.batchId,
        payload: payload satisfies PRCommentPayload,
      });
    }

    store.set(pendingKey(repo), pending);
    store.set(processedKey(repo), pruneProcessed(processed));
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
