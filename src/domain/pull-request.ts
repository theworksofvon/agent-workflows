export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequest {
  repo: RepoRef;
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
}

export interface ReviewTarget {
  repo: RepoRef;
  prNumber: number;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface ReviewContext {
  repo: RepoRef;
  prNumber: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  files: PullRequestFile[];
}
