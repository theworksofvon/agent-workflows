import { Octokit } from "octokit";

interface PullRequestApiRecord {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
  draft?: boolean | null;
}

interface IssueCommentApiRecord {
  id: number;
  user: { login?: string } | null;
  body?: string | null;
  created_at: string;
}

interface ReviewCommentApiRecord extends IssueCommentApiRecord {
  path: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk: string;
  pull_request_review_id?: number | null;
}

interface PullRequestFileApiRecord {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface RepoRequest {
  [key: string]: unknown;
  owner: string;
  repo: string;
}

interface PullRequestRequest extends RepoRequest {
  pull_number: number;
}

type ListFilesMethod = (
  args: PullRequestRequest & { per_page: number },
) => Promise<{
  data: PullRequestFileApiRecord[];
}>;

/** Minimal structural seam for the GitHub API operations consumed by this client. */
export interface GitHubApi {
  rest: {
    pulls: {
      list(
        args: RepoRequest & { state: "open"; per_page: number },
      ): Promise<{ data: PullRequestApiRecord[] }>;
      listReviewComments(
        args: PullRequestRequest & { per_page: number },
      ): Promise<{ data: ReviewCommentApiRecord[] }>;
      get(args: PullRequestRequest): Promise<{ data: PullRequestApiRecord }>;
      listFiles: ListFilesMethod;
      createReview(
        args: PullRequestRequest & {
          event: "COMMENT";
          body: string;
          comments: Array<{
            path: string;
            line: number;
            side: "RIGHT";
            body: string;
          }>;
        },
      ): Promise<unknown>;
    };
    issues: {
      listComments(
        args: RepoRequest & { issue_number: number; per_page: number },
      ): Promise<{ data: IssueCommentApiRecord[] }>;
      createComment(
        args: RepoRequest & { issue_number: number; body: string },
      ): Promise<unknown>;
    };
  };
  paginate(
    method: ListFilesMethod,
    args: PullRequestRequest & { per_page: number },
  ): Promise<PullRequestFileApiRecord[]>;
}

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

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullRequestReviewComment {
  path: string;
  line: number;
  body: string;
}

export class GitHubClient {
  readonly octokit: GitHubApi;

  constructor(
    token: string,
    options: { octokit?: GitHubApi; baseUrl?: string } = {},
  ) {
    this.octokit =
      options.octokit ?? new Octokit({ auth: token, baseUrl: options.baseUrl });
  }

  /** List open PRs for a repo. */
  async listOpenPRs(ref: RepoRef): Promise<PullRequestDetails[]> {
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
      draft: p.draft ?? false,
    }));
  }

  /** Issue/PR conversation comments, newest last. */
  async listIssueComments(
    ref: RepoRef,
    prNumber: number,
    since?: number,
  ): Promise<
    Array<{ id: number; author: string; body: string; createdAt: string }>
  > {
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
      reviewId: number | null;
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
      .map((c) => {
        return {
          id: c.id,
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
          path: c.path,
          line: c.line ?? null,
          originalLine: c.original_line ?? null,
          diffHunk: c.diff_hunk,
          createdAt: c.created_at,
          reviewId: c.pull_request_review_id ?? null,
        };
      });
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

  async getPullRequest(
    ref: RepoRef,
    prNumber: number,
  ): Promise<PullRequestDetails> {
    const res = await this.octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
    });
    return {
      number: res.data.number,
      title: res.data.title,
      body: res.data.body,
      headRef: res.data.head.ref,
      baseRef: res.data.base.ref,
      draft: res.data.draft ?? false,
    };
  }

  async listPullRequestFiles(
    ref: RepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]> {
    const files = await this.octokit.paginate(
      this.octokit.rest.pulls.listFiles,
      {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: prNumber,
        per_page: 100,
      },
    );
    return files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
    }));
  }

  async createPullRequestReview(args: {
    ref: RepoRef;
    prNumber: number;
    body: string;
    comments: PullRequestReviewComment[];
  }): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: args.ref.owner,
      repo: args.ref.repo,
      pull_number: args.prNumber,
      event: "COMMENT",
      body: args.body,
      comments: args.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        body: comment.body,
      })),
    });
  }
}
