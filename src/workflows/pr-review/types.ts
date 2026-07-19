import type { RepoRef } from "../../github/client.js";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface PRReviewTarget {
  repo: RepoRef;
  prNumber: number;
}

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
  severity: ReviewSeverity;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

/** Severities accepted by the structured review result contract. */
export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface ReviewRunSummary {
  reviewedAt: string;
  agent: string;
  findingCount: number;
  postedFindingCount: number;
  dryRun: boolean;
  summary: string;
}

export interface PullRequestReviewContext {
  repo: RepoRef;
  prNumber: number;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>;
}
