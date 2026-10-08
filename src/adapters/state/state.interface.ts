import type { RepoRef } from "../../domain/pull-request.js";

export interface RepoStatePort {
  getPostedReviewFindingKeys(prNumber: number): string[];
  /** Remembers posted review findings so a later review skips them. */
  recordPostedFindings(prNumber: number, keys: string[]): void;
}

export type StateFactory = (repo: RepoRef) => RepoStatePort;
