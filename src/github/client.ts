import { Octokit } from "octokit";

/**
 * Marker tag embedded in every comment this daemon writes. The poller filters
 * these out so the agent never reacts to its own output. Chose an HTML comment
 * so it's invisible in the rendered PR but trivially greppable.
 */
export const MARKER_TAG = "<!-- agent-workflows:bot -->";

export interface RepoRef {
  owner: string;
  repo: string;
}

export class GitHubClient {
  readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /** List open PRs for a repo. */
  async listOpenPRs(ref: RepoRef): Promise<
    Array<{ number: number; title: string; body: string | null; headRef: string; baseRef: string }>
  > {
    const res = await this.octokit.rest.pulls.list({
      owner: ref.owner,
      repo: ref.repo,
      state: "open",
      per_page: 100,
    });
    return res.data.map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body,
      headRef: p.head.ref,
      baseRef: p.base.ref,
    }));
  }

  /** Issue/PR conversation comments, newest last. */
  async listIssueComments(
    ref: RepoRef,
    prNumber: number,
    since?: number,
  ): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
    const res = await this.octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return res.data
      .filter((c) => (since ? Number(new Date(c.created_at)) > since : true))
      .map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: c.created_at,
      }));
  }

  /** Inline review comments on a PR, newest last. */
  async listReviewComments(
    ref: RepoRef,
    prNumber: number,
    since?: number,
  ): Promise<
    Array<{
      id: number;
      author: string;
      body: string;
      path: string;
      line: number | null;
      originalLine: number | null;
      diffHunk: string;
      createdAt: string;
    }>
  > {
    const res = await this.octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data
      .filter((c) => (since ? Number(new Date(c.created_at)) > since : true))
      .map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        path: c.path,
        line: c.line ?? null,
        originalLine: c.original_line ?? null,
        diffHunk: c.diff_hunk,
        createdAt: c.created_at,
      }));
  }

  async createComment(
    ref: RepoRef,
    prNumber: number,
    body: string,
  ): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      body,
    });
  }
}
