import {
  checksRollup,
  pullState,
  reviewDecision,
  toCheckStatus,
  type Check,
  type PullCard,
  type PullDetail,
} from "../../domain/inbox.js";

/*
 * additions, deletions, and changedFiles come in the same query. T3 Code
 * fetches them in a second query for speed; at 50 rows a group the cost is
 * small, and one query keeps a row complete when it first shows.
 */
const CARD_FIELDS = `
  __typename
  number
  title
  url
  state
  isDraft
  reviewDecision
  updatedAt
  additions
  deletions
  changedFiles
  headRefName
  baseRefName
  author { login avatarUrl }
  repository { name owner { login } }
  commits(last: 1) {
    nodes {
      commit {
        committedDate
        author { name user { login } }
        statusCheckRollup { state }
      }
    }
  }`;

export const SEARCH_PULLS = `query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes { ... on PullRequest { ${CARD_FIELDS} } }
  }
}`;

export const REPO_PULLS = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${CARD_FIELDS} }
    }
  }
}`;

export const PULL_DETAIL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${CARD_FIELDS} body headRefOid isCrossRepository }
  }
}`;

export const PULL_CHECKS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl startedAt completedAt
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  ... on StatusContext { context state targetUrl createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface CardNode {
  __typename?: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  headRefName: string;
  baseRefName: string;
  author: { login: string; avatarUrl: string | null } | null;
  repository: { name: string; owner: { login: string } };
  commits: {
    nodes: Array<{
      commit: {
        committedDate: string | null;
        author: {
          name: string | null;
          user: { login: string } | null;
        } | null;
        statusCheckRollup: { state: string } | null;
      };
    }>;
  };
}

export interface DetailNode extends CardNode {
  body: string | null;
  headRefOid: string;
  isCrossRepository: boolean;
}

export type ContextNode =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
      checkSuite: {
        workflowRun: { workflow: { name: string } } | null;
      } | null;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      createdAt: string | null;
    };

/** A node is null when an error, such as an SSO-protected org, hid it. */
export interface SearchData {
  search: {
    issueCount: number;
    nodes: Array<CardNode | Record<string, never> | null>;
  } | null;
}
export interface RepoPullsData {
  repository: { pullRequests: { nodes: CardNode[] } };
}
export interface DetailData {
  repository: { pullRequest: DetailNode };
}
export interface ChecksData {
  repository: {
    pullRequest: {
      headRefOid: string;
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              state: string;
              contexts: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: ContextNode[];
              };
            } | null;
          };
        }>;
      };
    };
  };
}

export function toCard(node: CardNode): PullCard {
  const commit = node.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup?.state;
  return {
    repo: { owner: node.repository.owner.login, repo: node.repository.name },
    number: node.number,
    title: node.title,
    url: node.url,
    // A deleted user's PR has no author; GitHub shows it as ghost.
    author: {
      login: node.author?.login ?? "ghost",
      avatarUrl: node.author?.avatarUrl ?? null,
    },
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    state: pullState(node.state, node.isDraft),
    reviewDecision: reviewDecision(node.reviewDecision),
    updatedAt: node.updatedAt,
    lastCommit: commit
      ? {
          authorLogin: commit.author?.user?.login ?? null,
          authorName: commit.author?.name ?? null,
          committedAt: commit.committedDate,
        }
      : null,
    checks: rollup ? checksRollup([toCheckStatus({ state: rollup })]) : null,
    additions: node.additions ?? null,
    deletions: node.deletions ?? null,
    changedFiles: node.changedFiles ?? null,
  };
}

export function toDetail(node: DetailNode): PullDetail {
  return {
    ...toCard(node),
    body: node.body || null,
    headSha: node.headRefOid,
    fromFork: node.isCrossRepository,
  };
}

/** A search also matches issues, which arrive as empty objects. */
export function isPullRequest(
  node: CardNode | Record<string, never> | null,
): node is CardNode {
  return node?.__typename === "PullRequest";
}

export function toCheck(node: ContextNode): Check {
  if (node.__typename === "CheckRun")
    return {
      name: node.name,
      workflowName: node.checkSuite?.workflowRun?.workflow.name ?? null,
      status: toCheckStatus(node),
      url: node.detailsUrl,
      startedAt: realTime(node.startedAt),
      completedAt: realTime(node.completedAt),
    };
  return {
    name: node.context,
    workflowName: null,
    status: toCheckStatus({ state: node.state }),
    url: node.targetUrl,
    startedAt: realTime(node.createdAt),
    completedAt: null,
  };
}

/** GitHub writes this where a run has not reached that moment yet. */
const UNSET_TIME = "0001-01-01T00:00:00Z";

function realTime(value: string | null): string | null {
  return value === null || value === UNSET_TIME ? null : value;
}
