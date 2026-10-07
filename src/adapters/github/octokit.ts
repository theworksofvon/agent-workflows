import { Octokit } from "octokit";
import type {
  PullRequest,
  PullRequestFile,
  RepoRef,
} from "../../domain/pull-request.js";
import type {
  GitHubPort,
  PullChecks,
  PullSearch,
  ReviewCommentDraft,
} from "./github.interface.js";
import {
  toCheckStatus,
  type Account,
  type Check,
  type PullCard,
  type PullDetail,
} from "../../domain/inbox.js";
import { RateLimitedError } from "../../domain/errors.js";
import { errorMessage } from "../../domain/util.js";
import {
  isPullRequest,
  PULL_CHECKS,
  PULL_DETAIL,
  REPO_PULLS,
  SEARCH_PULLS,
  toCard,
  toCheck,
  toDetail,
  type ChecksData,
  type DetailData,
  type RepoPullsData,
  type SearchData,
} from "./graphql.js";

interface PullRequestApiRecord {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
  draft?: boolean | null;
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
      get(args: PullRequestRequest): Promise<{ data: PullRequestApiRecord }>;
      listFiles: ListFilesMethod;
      createReview(
        args: PullRequestRequest & {
          event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
          body: string;
          commit_id?: string;
          comments: Array<{
            path: string;
            line: number;
            side: "RIGHT";
            body: string;
          }>;
        },
      ): Promise<unknown>;
    };
    users: {
      getAuthenticated(): Promise<{
        data: { login: string; avatar_url: string | null };
      }>;
    };
  };
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  paginate(
    method: ListFilesMethod,
    args: PullRequestRequest & { per_page: number },
  ): Promise<PullRequestFileApiRecord[]>;
}

/** 5 pages of 100 check contexts; GitHub's own rollup covers the rest. */
export const CHECK_PAGES = 5;

/**
 * Runs a GraphQL request and keeps the data of an answer that also carries
 * errors, when `usable` accepts it. A rate limit is a RateLimitedError.
 */
async function partialGraphql<T>(
  run: () => Promise<T>,
  usable: (data: T) => boolean,
): Promise<{ data: T; warnings: string[] }> {
  try {
    return { data: await run(), warnings: [] };
  } catch (err) {
    if (isRateLimited(err))
      throw new RateLimitedError(errorMessage(err), { cause: err });
    const answer = err as {
      name?: string;
      data?: T | null;
      errors?: Array<{ message: string }>;
    };
    if (answer.name !== "GraphqlResponseError" || !answer.data) throw err;
    if (!usable(answer.data)) throw err;
    return {
      data: answer.data,
      warnings: (answer.errors ?? []).map((e) => e.message),
    };
  }
}

/** A 429, a 403 that names a rate limit, or a GraphQL RATE_LIMITED error. */
export function isRateLimited(err: unknown): boolean {
  const e = err as {
    status?: number;
    message?: string;
    errors?: Array<{ type?: string }>;
  };
  if (e.status === 429) return true;
  if (e.status === 403 && /rate limit/i.test(String(e.message))) return true;
  return (e.errors ?? []).some((x) => x.type === "RATE_LIMITED");
}

export class GitHubClient implements GitHubPort {
  readonly octokit: GitHubApi;

  constructor(
    token: string,
    options: { octokit?: GitHubApi; baseUrl?: string } = {},
  ) {
    this.octokit =
      options.octokit ?? new Octokit({ auth: token, baseUrl: options.baseUrl });
  }

  /** The account the token belongs to. */
  async viewer(): Promise<Account> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return { login: data.login, avatarUrl: data.avatar_url ?? null };
  }

  /**
   * A search that GitHub answers with errors and data, as when an org
   * requires SSO, returns the data with the errors as warnings.
   */
  async searchPullRequests(query: string, first: number): Promise<PullSearch> {
    const { data, warnings } = await partialGraphql(
      () => this.octokit.graphql<SearchData>(SEARCH_PULLS, { q: query, first }),
      (answer) => answer.search !== null,
    );
    // The predicate above guarantees a search.
    const search = data.search!;
    return {
      pulls: search.nodes.filter(isPullRequest).map(toCard),
      truncated: search.issueCount > search.nodes.length,
      warnings,
    };
  }

  /** Open PRs of a repository, most recently updated first. */
  async listRepoPullRequests(ref: RepoRef, first: number): Promise<PullCard[]> {
    const data = await this.octokit.graphql<RepoPullsData>(REPO_PULLS, {
      owner: ref.owner,
      name: ref.repo,
      first,
    });
    return data.repository.pullRequests.nodes.map(toCard);
  }

  async getPullRequestDetail(
    ref: RepoRef,
    prNumber: number,
  ): Promise<PullDetail> {
    const data = await this.octokit.graphql<DetailData>(PULL_DETAIL, {
      owner: ref.owner,
      name: ref.repo,
      number: prNumber,
    });
    return toDetail(data.repository.pullRequest);
  }

  /**
   * The check contexts on the PR's head commit, as GitHub lists them, up to
   * CHECK_PAGES pages of 100.
   */
  async getPullRequestChecks(
    ref: RepoRef,
    prNumber: number,
  ): Promise<PullChecks> {
    const checks: Check[] = [];
    let after: string | null = null;
    for (let page = 1; ; page++) {
      const data: ChecksData = await this.octokit.graphql<ChecksData>(
        PULL_CHECKS,
        { owner: ref.owner, name: ref.repo, number: prNumber, after },
      );
      const pull = data.repository.pullRequest;
      const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
      checks.push(...(rollup?.contexts.nodes ?? []).map(toCheck));
      const more = rollup?.contexts.pageInfo.hasNextPage === true;
      if (!more || page === CHECK_PAGES)
        return {
          headSha: pull.headRefOid,
          checks,
          truncated: more,
          overall: rollup ? toCheckStatus({ state: rollup.state }) : null,
        };
      after = rollup.contexts.pageInfo.endCursor;
    }
  }

  async getPullRequest(ref: RepoRef, prNumber: number): Promise<PullRequest> {
    const res = await this.octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
    });
    const p = res.data;
    return {
      repo: ref,
      number: p.number,
      title: p.title,
      body: p.body,
      headRef: p.head.ref,
      baseRef: p.base.ref,
      draft: p.draft ?? false,
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
    event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    commitId?: string;
  }): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: args.repo.owner,
      repo: args.repo.repo,
      pull_number: args.prNumber,
      event: args.event ?? "COMMENT",
      body: args.body,
      ...(args.commitId ? { commit_id: args.commitId } : {}),
      comments: args.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        body: comment.body,
      })),
    });
  }
}
