import type { RepoRef } from "../../domain/events.js";

export interface WorkdirHandle {
  /** Absolute path to the checkout. */
  path: string;
  /** Branch checked out. */
  branch: string;
  /** Temporary local branch backing this worktree. */
  localBranch: string;
  /** Remote branch SHA this worktree was based on. Used for explicit push leases. */
  baseSha: string;
  /** Cached bare repository that owns this worktree. */
  repoCachePath: string;
}

export interface GitPort {
  prepareWorkdir(args: {
    stateDir: string;
    repo: RepoRef;
    branch: string;
    taskId: string;
    token: string;
    cloneUrlOverride?: string;
  }): WorkdirHandle;
  cleanupWorkdir(handle: WorkdirHandle, keep: boolean): void;
  hasUncommittedChanges(workdir: string): boolean;
  commitUncommittedChanges(workdir: string, message: string): boolean;
  commitsAhead(workdir: string, branch: string): number;
  /** Throws when the lease is rejected. */
  pushBranch(workdir: string, branch: string, expectedRemoteSha: string): void;
}
