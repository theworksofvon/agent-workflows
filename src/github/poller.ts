import type { Source, Event } from "../sources/types.js";
import type { Config, RepoSpec } from "../config.js";
import type { Store } from "../store.js";
import type { GitHubClient } from "./client.js";
import { MARKER_TAG } from "./client.js";
import { log } from "../log.js";

/** Payload shape the pr_comment workflow expects. */
export interface PRCommentPayload {
  repo: RepoSpec;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  headRef: string;
  baseRef: string;
  comment: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
  };
  /** Present only for inline review comments — this is the "no bridge" context. */
  review?: {
    path: string;
    line: number | null;
    diffHunk: string;
  };
}

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

  /** True if a comment was authored by this daemon or tagged as its output. */
  function isSelf(body: string, author: string): boolean {
    if (body.includes(MARKER_TAG)) return true;
    return author.toLowerCase() === config.agentSelfUser.toLowerCase();
  }

  async function pollRepo(repo: RepoSpec): Promise<Event[]> {
    const events: Event[] = [];
    const prs = await client.listOpenPRs(repo);

    for (const pr of prs) {
      // --- conversation comments ---
      const lastIssue = store.get<number>(cursorKey(repo, "issue"), 0);
      const issueComments = await client.listIssueComments(repo, pr.number);
      for (const c of issueComments) {
        if (c.id <= lastIssue) continue;
        if (isSelf(c.body, c.author)) continue;
        events.push({
          kind: "pr_comment",
          id: `issue:${repo.owner}/${repo.repo}:${pr.number}:${c.id}`,
          payload: {
            repo,
            prNumber: pr.number,
            prTitle: pr.title,
            prBody: pr.body,
            headRef: pr.headRef,
            baseRef: pr.baseRef,
            comment: { id: c.id, author: c.author, body: c.body, createdAt: c.createdAt },
          } satisfies PRCommentPayload,
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
        events.push({
          kind: "pr_comment",
          id: `review:${repo.owner}/${repo.repo}:${pr.number}:${c.id}`,
          payload: {
            repo,
            prNumber: pr.number,
            prTitle: pr.title,
            prBody: pr.body,
            headRef: pr.headRef,
            baseRef: pr.baseRef,
            comment: { id: c.id, author: c.author, body: c.body, createdAt: c.createdAt },
            review: { path: c.path, line: c.line ?? c.originalLine, diffHunk: c.diffHunk },
          } satisfies PRCommentPayload,
        });
      }
      const maxReview = reviewComments.reduce((m, c) => Math.max(m, c.id), lastReview);
      store.set(cursorKey(repo, "review"), maxReview);
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
