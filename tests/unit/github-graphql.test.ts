import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_PAGES,
  GitHubClient,
  isRateLimited,
  type GitHubApi,
} from "../../src/adapters/github/octokit.js";
import { RateLimitedError } from "../../src/domain/errors.js";
import {
  PULL_CHECKS,
  PULL_DETAIL,
  REPO_PULLS,
  SEARCH_PULLS,
  type CardNode,
} from "../../src/adapters/github/graphql.js";

const repo = { owner: "acme", repo: "widgets" };

function node(overrides: Partial<CardNode> = {}): CardNode {
  return {
    __typename: "PullRequest",
    number: 7,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/7",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    updatedAt: "2026-10-07T00:00:00Z",
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    headRefName: "feat/widgets",
    baseRefName: "main",
    author: { login: "octocat", avatarUrl: "https://avatars.test/octocat" },
    repository: { name: "widgets", owner: { login: "acme" } },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-10-06T00:00:00Z",
            author: { name: "Bob", user: { login: "bob" } },
            statusCheckRollup: { state: "FAILURE" },
          },
        },
      ],
    },
    ...overrides,
  };
}

/** A client whose GraphQL answers come from `answer`, recording each call. */
function client(
  answer: (query: string, variables: Record<string, unknown>) => unknown,
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const api = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
      calls.push([query, variables]);
      return answer(query, variables);
    },
    rest: {
      users: {
        getAuthenticated: async () => ({
          data: { login: "alice", avatar_url: "https://avatars.test/alice" },
        }),
      },
    },
  } as unknown as GitHubApi;
  return { github: new GitHubClient("unused", { octokit: api }), calls };
}

test("viewer is the token's account", async () => {
  const { github } = client(() => null);
  assert.deepEqual(await github.viewer(), {
    login: "alice",
    avatarUrl: "https://avatars.test/alice",
  });
  (
    github.octokit.rest.users as {
      getAuthenticated(): Promise<{ data: object }>;
    }
  ).getAuthenticated = async () => ({
    data: { login: "bot", avatar_url: null },
  });
  assert.deepEqual(await github.viewer(), { login: "bot", avatarUrl: null });
});

test("search maps pull requests to cards and drops issues", async () => {
  const { github, calls } = client(() => ({
    search: { issueCount: 2, nodes: [node(), {}] },
  }));
  const found = await github.searchPullRequests("is:pr author:@me", 50);
  assert.deepEqual(calls, [
    [SEARCH_PULLS, { q: "is:pr author:@me", first: 50 }],
  ]);
  assert.equal(found.truncated, false);
  assert.deepEqual(found.warnings, []);
  assert.deepEqual(found.pulls, [
    {
      repo,
      number: 7,
      title: "Add widgets",
      url: "https://github.com/acme/widgets/pull/7",
      author: { login: "octocat", avatarUrl: "https://avatars.test/octocat" },
      headRef: "feat/widgets",
      baseRef: "main",
      state: "open",
      reviewDecision: "approved",
      updatedAt: "2026-10-07T00:00:00Z",
      lastCommit: {
        authorLogin: "bob",
        authorName: "Bob",
        committedAt: "2026-10-06T00:00:00Z",
      },
      checks: "failing",
      additions: 3,
      deletions: 1,
      changedFiles: 2,
    },
  ]);
});

test("a card tolerates a deleted author, no commits, and missing counts", async () => {
  const bare = node({
    author: null,
    isDraft: true,
    reviewDecision: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    commits: { nodes: [] },
  });
  const noRollup = node({
    commits: {
      nodes: [
        {
          commit: {
            committedDate: null,
            author: { name: null, user: null },
            statusCheckRollup: null,
          },
        },
      ],
    },
  });
  const noCommitAuthor = node({
    commits: {
      nodes: [
        {
          commit: {
            committedDate: null,
            author: null,
            statusCheckRollup: { state: "PENDING" },
          },
        },
      ],
    },
  });
  const { github, calls } = client(() => ({
    repository: { pullRequests: { nodes: [bare, noRollup, noCommitAuthor] } },
  }));
  const [a, b, c] = await github.listRepoPullRequests(repo, 50);
  assert.deepEqual(calls, [
    [REPO_PULLS, { owner: "acme", name: "widgets", first: 50 }],
  ]);
  assert.deepEqual(a.author, { login: "ghost", avatarUrl: null });
  assert.equal(a.state, "draft");
  assert.equal(a.reviewDecision, null);
  assert.equal(a.lastCommit, null);
  assert.equal(a.checks, null);
  assert.deepEqual(
    [a.additions, a.deletions, a.changedFiles],
    [null, null, null],
  );
  assert.deepEqual(b.lastCommit, {
    authorLogin: null,
    authorName: null,
    committedAt: null,
  });
  assert.equal(b.checks, null);
  assert.equal(c.lastCommit?.authorLogin, null);
  assert.equal(c.checks, "pending");
});

test("a detail adds the body, head commit, and fork flag", async () => {
  let body: string | null = "Adds widgets.";
  const { github, calls } = client(() => ({
    repository: {
      pullRequest: {
        ...node(),
        body,
        headRefOid: "abc123",
        isCrossRepository: true,
      },
    },
  }));
  const pull = await github.getPullRequestDetail(repo, 7);
  assert.deepEqual(calls, [
    [PULL_DETAIL, { owner: "acme", name: "widgets", number: 7 }],
  ]);
  assert.equal(pull.body, "Adds widgets.");
  assert.equal(pull.headSha, "abc123");
  assert.equal(pull.fromFork, true);
  body = "";
  assert.equal((await github.getPullRequestDetail(repo, 7)).body, null);
});

test("checks map check runs and commit statuses from the head commit", async () => {
  let commits: unknown[] = [
    {
      commit: {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                __typename: "CheckRun",
                name: "test",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                detailsUrl: "https://ci.test/1",
                startedAt: "2026-10-07T00:00:00Z",
                completedAt: "2026-10-07T00:05:00Z",
                checkSuite: { workflowRun: { workflow: { name: "CI" } } },
              },
              {
                __typename: "CheckRun",
                name: "external",
                status: "QUEUED",
                conclusion: null,
                detailsUrl: null,
                startedAt: "0001-01-01T00:00:00Z",
                completedAt: null,
                checkSuite: { workflowRun: null },
              },
              {
                __typename: "CheckRun",
                name: "app",
                status: "COMPLETED",
                conclusion: "NEUTRAL",
                detailsUrl: null,
                startedAt: null,
                completedAt: null,
                checkSuite: null,
              },
              {
                __typename: "StatusContext",
                context: "deploy/preview",
                state: "PENDING",
                targetUrl: "https://deploy.test",
                createdAt: "2026-10-07T00:01:00Z",
              },
            ],
          },
        },
      },
    },
  ];
  const { github, calls } = client(() => ({
    repository: {
      pullRequest: { headRefOid: "abc123", commits: { nodes: commits } },
    },
  }));
  const result = await github.getPullRequestChecks(repo, 7);
  assert.deepEqual(calls, [
    [PULL_CHECKS, { owner: "acme", name: "widgets", number: 7, after: null }],
  ]);
  assert.equal(result.headSha, "abc123");
  assert.equal(result.truncated, false);
  assert.equal(result.overall, "pending");
  assert.deepEqual(result.checks, [
    {
      name: "test",
      workflowName: "CI",
      status: "success",
      url: "https://ci.test/1",
      startedAt: "2026-10-07T00:00:00Z",
      completedAt: "2026-10-07T00:05:00Z",
    },
    {
      name: "external",
      workflowName: null,
      status: "pending",
      url: null,
      startedAt: null,
      completedAt: null,
    },
    {
      name: "app",
      workflowName: null,
      status: "neutral",
      url: null,
      startedAt: null,
      completedAt: null,
    },
    {
      name: "deploy/preview",
      workflowName: null,
      status: "pending",
      url: "https://deploy.test",
      startedAt: "2026-10-07T00:01:00Z",
      completedAt: null,
    },
  ]);

  commits = [{ commit: { statusCheckRollup: null } }];
  assert.deepEqual(await github.getPullRequestChecks(repo, 7), {
    headSha: "abc123",
    checks: [],
    truncated: false,
    overall: null,
  });
  commits = [];
  assert.deepEqual((await github.getPullRequestChecks(repo, 7)).checks, []);
});

function statusPage(index: number, hasNextPage: boolean) {
  return {
    repository: {
      pullRequest: {
        headRefOid: "abc123",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    pageInfo: { hasNextPage, endCursor: `cursor-${index}` },
                    nodes: [
                      {
                        __typename: "StatusContext",
                        context: `ci/${index}`,
                        state: index === 2 ? "FAILURE" : "SUCCESS",
                        targetUrl: null,
                        createdAt: null,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

test("checks read every page of contexts up to the page cap", async () => {
  const pages = 3;
  const { github, calls } = client((_, variables) => {
    const index =
      variables.after === null
        ? 1
        : Number(String(variables.after).split("-")[1]) + 1;
    return statusPage(index, index < pages);
  });
  const result = await github.getPullRequestChecks(repo, 7);
  assert.deepEqual(
    calls.map(([, v]) => v.after),
    [null, "cursor-1", "cursor-2"],
  );
  assert.deepEqual(
    result.checks.map((c) => [c.name, c.status]),
    [
      ["ci/1", "success"],
      ["ci/2", "failure"],
      ["ci/3", "success"],
    ],
  );
  assert.equal(result.truncated, false);

  const endless = client((_, variables) => {
    const index =
      variables.after === null
        ? 1
        : Number(String(variables.after).split("-")[1]) + 1;
    return statusPage(index, true);
  });
  const capped = await endless.github.getPullRequestChecks(repo, 7);
  assert.equal(endless.calls.length, CHECK_PAGES);
  assert.equal(capped.checks.length, CHECK_PAGES);
  assert.equal(capped.truncated, true);
  assert.equal(capped.overall, "failure");
});

/** An answer with errors, as octokit's GraphqlResponseError carries it. */
function responseError(data: unknown, errors?: Array<{ message: string }>) {
  return Object.assign(
    new Error("Request failed due to following response errors"),
    {
      name: "GraphqlResponseError",
      data,
      errors,
    },
  );
}

test("a search keeps the data GitHub returned beside errors, as warnings", async () => {
  const { github } = client(() => {
    throw responseError({ search: { issueCount: 60, nodes: [node(), null] } }, [
      { message: "Resource protected by organization SAML enforcement." },
    ]);
  });
  const found = await github.searchPullRequests("is:pr", 50);
  assert.equal(found.pulls.length, 1);
  assert.equal(found.truncated, true);
  assert.deepEqual(found.warnings, [
    "Resource protected by organization SAML enforcement.",
  ]);

  const bare = client(() => {
    throw responseError({ search: { issueCount: 0, nodes: [] } });
  });
  assert.deepEqual(
    (await bare.github.searchPullRequests("is:pr", 50)).warnings,
    [],
  );

  for (const thrown of [
    responseError({ search: null }, [{ message: "search failed" }]),
    responseError(null, [{ message: "no data" }]),
    new Error("offline"),
  ]) {
    const failing = client(() => {
      throw thrown;
    });
    await assert.rejects(
      failing.github.searchPullRequests("is:pr", 50),
      (err) => err === thrown,
    );
  }
});

test("a rate-limited search throws RateLimitedError", async () => {
  for (const thrown of [
    Object.assign(new Error("Too many requests"), { status: 429 }),
    Object.assign(new Error("API rate limit exceeded for user"), {
      status: 403,
    }),
    Object.assign(new Error("You have exceeded a secondary rate limit"), {
      status: 403,
    }),
    responseError({ search: null }, [{ message: "limit" }]),
  ]) {
    if (!("status" in thrown))
      Object.assign(thrown, {
        errors: [{ type: "RATE_LIMITED", message: "limit" }],
      });
    const { github } = client(() => {
      throw thrown;
    });
    await assert.rejects(
      github.searchPullRequests("is:pr", 50),
      RateLimitedError,
    );
  }
  assert.equal(
    isRateLimited(
      Object.assign(new Error("Resource not accessible"), { status: 403 }),
    ),
    false,
  );
  assert.equal(isRateLimited(new Error("offline")), false);
});
