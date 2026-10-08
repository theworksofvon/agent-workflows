import type {
  Account,
  Check,
  CheckStatus,
  PullCard,
  PullDetail,
} from "../../domain/inbox.js";
import type {
  PullRequest,
  PullRequestFile,
  RepoRef,
} from "../../domain/pull-request.js";

export interface ReviewCommentDraft {
  path: string;
  line: number;
  body: string;
}

/** One search's pull requests, with what limited them. */
export interface PullSearch {
  pulls: PullCard[];
  /** GitHub matched more than `first`. */
  truncated: boolean;
  /** Errors GitHub returned beside partial data, such as an SSO-protected org. */
  warnings: string[];
}

export interface PullChecks {
  headSha: string;
  checks: Check[];
  /** More contexts exist than the pages read. */
  truncated: boolean;
  /** GitHub's own rollup of every context, or null without one. */
  overall: CheckStatus | null;
}

export interface GitHubPort {
  viewer(): Promise<Account>;
  /** Throws RateLimitedError when the account hit a rate limit. */
  searchPullRequests(query: string, first: number): Promise<PullSearch>;
  listRepoPullRequests(repo: RepoRef, first: number): Promise<PullCard[]>;
  getPullRequestDetail(repo: RepoRef, prNumber: number): Promise<PullDetail>;
  getPullRequestChecks(repo: RepoRef, prNumber: number): Promise<PullChecks>;
  getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequest>;
  listPullRequestFiles(
    repo: RepoRef,
    prNumber: number,
  ): Promise<PullRequestFile[]>;
  createPullRequestReview(args: {
    repo: RepoRef;
    prNumber: number;
    body: string;
    comments: ReviewCommentDraft[];
    /** Defaults to COMMENT. */
    event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    /**
     * The commit the comment lines refer to. Without it GitHub maps each
     * line against the current head, which can differ from the reviewed one.
     */
    commitId?: string;
  }): Promise<void>;
}
