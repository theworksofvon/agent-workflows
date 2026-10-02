import { Octokit } from "octokit";
import type {
  PullRequest,
  PullRequestFile,
  RepoRef,
} from "../../domain/events.js";
import type {
  GitHubPort,
  HookDelivery,
  HookRecord,
  IssueCommentRecord,
  ReviewCommentDraft,
  ReviewCommentRecord,
} from "./github.interface.js";

interface PullRequestApiRecord {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; repo?: { full_name: string } | null };
  base: { ref: string; repo?: { full_name: string } | null };
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

interface HookApiRecord {
  id: number;
  events: string[];
  active: boolean;
  config?: { url?: string };
}

interface HookDeliveryApiRecord {
  id: number;
  event: string;
  status_code: number;
  delivered_at: string;
  redelivery: boolean;
}

interface HookConfigRequest {
  events: string[];
  active: boolean;
  config: { url: string; content_type: "json"; secret: string };
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
      createReplyForReviewComment(
        args: PullRequestRequest & { comment_id: number; body: string },
      ): Promise<unknown>;
    };
    repos: {
      listWebhooks(
        args: RepoRequest & { per_page: number },
      ): Promise<{ data: HookApiRecord[] }>;
      createWebhook(
        args: RepoRequest & HookConfigRequest,
      ): Promise<{ data: HookApiRecord }>;
      updateWebhook(
        args: RepoRequest & HookConfigRequest & { hook_id: number },
      ): Promise<{ data: HookApiRecord }>;
      listWebhookDeliveries(
        args: RepoRequest & { hook_id: number; per_page: number },
      ): Promise<{ data: HookDeliveryApiRecord[] }>;
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

export class GitHubClient implements GitHubPort {
  readonly octokit: GitHubApi;

  constructor(
    token: string,
    options: { octokit?: GitHubApi; baseUrl?: string } = {},
  ) {
    this.octokit =
      options.octokit ?? new Octokit({ auth: token, baseUrl: options.baseUrl });
  }

  /** List open PRs for a repo. */
  async listOpenPRs(ref: RepoRef): Promise<PullRequest[]> {
    const res = await this.octokit.rest.pulls.list({
      owner: ref.owner,
      repo: ref.repo,
      state: "open",
      per_page: 100,
    });
    return res.data.map((p) => ({
      repo: ref,
      number: p.number,
      title: p.title,
      body: p.body,
      headRef: p.head.ref,
      baseRef: p.base.ref,
      draft: p.draft ?? false,
      fromFork: isFromFork(p),
    }));
  }

  /** Issue/PR conversation comments, newest last. */
  async listIssueComments(
    ref: RepoRef,
    prNumber: number,
  ): Promise<IssueCommentRecord[]> {
    const res = await this.octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return res.data.map((c) => ({
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
  ): Promise<ReviewCommentRecord[]> {
    const res = await this.octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      path: c.path,
      line: c.line ?? null,
      originalLine: c.original_line ?? null,
      diffHunk: c.diff_hunk,
      createdAt: c.created_at,
      reviewId: c.pull_request_review_id ?? null,
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

  async getPullRequest(ref: RepoRef, prNumber: number): Promise<PullRequest> {
    const res = await this.octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
    });
    return {
      repo: ref,
      number: res.data.number,
      title: res.data.title,
      body: res.data.body,
      headRef: res.data.head.ref,
      baseRef: res.data.base.ref,
      draft: res.data.draft ?? false,
      fromFork: isFromFork(res.data),
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
    repo: RepoRef;
    prNumber: number;
    body: string;
    comments: ReviewCommentDraft[];
  }): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: args.repo.owner,
      repo: args.repo.repo,
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

  async replyToReviewComment(
    ref: RepoRef,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.octokit.rest.pulls.createReplyForReviewComment({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
  }

  async listHooks(ref: RepoRef): Promise<HookRecord[]> {
    const res = await this.octokit.rest.repos.listWebhooks({
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    return res.data.map(toHookRecord);
  }

  async createHook(
    ref: RepoRef,
    args: { url: string; secret: string; events: string[] },
  ): Promise<HookRecord> {
    const res = await this.octokit.rest.repos.createWebhook({
      owner: ref.owner,
      repo: ref.repo,
      ...hookConfig(args),
    });
    return toHookRecord(res.data);
  }

  async updateHook(
    ref: RepoRef,
    hookId: number,
    args: { url: string; secret: string; events: string[] },
  ): Promise<HookRecord> {
    const res = await this.octokit.rest.repos.updateWebhook({
      owner: ref.owner,
      repo: ref.repo,
      hook_id: hookId,
      ...hookConfig(args),
    });
    return toHookRecord(res.data);
  }

  async listHookDeliveries(
    ref: RepoRef,
    hookId: number,
  ): Promise<HookDelivery[]> {
    const res = await this.octokit.rest.repos.listWebhookDeliveries({
      owner: ref.owner,
      repo: ref.repo,
      hook_id: hookId,
      per_page: 30,
    });
    return res.data.map((d) => ({
      id: d.id,
      event: d.event,
      statusCode: d.status_code,
      deliveredAt: d.delivered_at,
      redelivery: d.redelivery,
    }));
  }
}

function isFromFork(p: PullRequestApiRecord): boolean {
  const head = p.head.repo?.full_name;
  const base = p.base.repo?.full_name;
  if (head === undefined || base === undefined) return false;
  return head !== base;
}

function hookConfig(args: {
  url: string;
  secret: string;
  events: string[];
}): HookConfigRequest {
  return {
    events: args.events,
    active: true,
    config: { url: args.url, content_type: "json", secret: args.secret },
  };
}

function toHookRecord(h: HookApiRecord): HookRecord {
  return {
    id: h.id,
    url: h.config?.url ?? "",
    events: h.events,
    active: h.active,
  };
}
