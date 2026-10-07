import type { GitHubAccountsPort } from "../../src/adapters/github/accounts.js";
import { UnknownAccountError } from "../../src/adapters/github/accounts.js";
import type { SettingsStore } from "../../src/adapters/state/settings.js";
import type { PullCard, PullDetail } from "../../src/domain/inbox.js";
import type { AccountClient } from "../../src/services/github-access.js";

/** gh with these logins, the first one active; a token is `token:<login>`. */
export function fakeAccounts(logins = ["alice", "bob"]): GitHubAccountsPort {
  return {
    async list() {
      return logins.map((login) => ({
        login,
        avatarUrl: `https://avatars.test/${login}`,
        ok: true,
      }));
    },
    async active() {
      return logins[0];
    },
    async token(login) {
      if (!logins.includes(login))
        throw new UnknownAccountError(`unknown GitHub account: ${login}`);
      return `token:${login}`;
    },
    async isFallback() {
      return false;
    },
  };
}

export function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

export function card(overrides: Partial<PullCard> = {}): PullCard {
  return {
    repo: { owner: "acme", repo: "widgets" },
    number: 7,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/7",
    author: { login: "octocat", avatarUrl: null },
    headRef: "feat/widgets",
    baseRef: "main",
    state: "open",
    reviewDecision: null,
    updatedAt: "2026-10-07T00:00:00Z",
    lastCommit: null,
    checks: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

export function detail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    ...card(),
    body: "Adds widgets.",
    headSha: "abc123",
    fromFork: false,
    ...overrides,
  };
}

/**
 * A GitHub client that records `[method, token, ...args]` for each call;
 * every method is replaceable.
 */
export function fakeClient(
  token: string,
  calls: unknown[][],
  overrides: Partial<AccountClient> = {},
): AccountClient {
  return {
    async searchPullRequests(query, first) {
      calls.push(["search", token, query, first]);
      return { pulls: [], truncated: false, warnings: [] };
    },
    async listRepoPullRequests(repo, first) {
      calls.push(["repoPulls", token, repo, first]);
      return [];
    },
    async getPullRequestDetail(repo, prNumber) {
      calls.push(["detail", token, repo, prNumber]);
      return detail({ repo, number: prNumber });
    },
    async getPullRequestChecks(repo, prNumber) {
      calls.push(["checks", token, repo, prNumber]);
      return { headSha: "abc123", checks: [], truncated: false, overall: null };
    },
    async listPullRequestFiles(repo, prNumber) {
      calls.push(["files", token, repo, prNumber]);
      return [];
    },
    async createPullRequestReview(args) {
      calls.push(["review", token, args]);
    },
    ...overrides,
  };
}
