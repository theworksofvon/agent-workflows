import type { RepoRef } from "../../domain/pull-request.js";

export interface WorkdirHandle {
  /** Absolute path to the checkout. */
  path: string;
  /** Branch checked out. */
  branch: string;
  /** Temporary local branch backing this worktree. */
  localBranch: string;
  /** Cached bare repository that owns this worktree. */
  repoCachePath: string;
}

export interface GitPort {
  prepareWorkdir(args: {
    stateDir: string;
    repo: RepoRef;
    branch: string;
    /** Also fetched, so `origin/<baseBranch>` resolves in the worktree. */
    baseBranch?: string;
    /**
     * Check out this commit instead of the branch tip. Fetched by SHA when
     * the fetched branch no longer contains it.
     */
    commit?: string;
    taskId: string;
    token: string;
    cloneUrlOverride?: string;
  }): WorkdirHandle;
  cleanupWorkdir(handle: WorkdirHandle, keep: boolean): void;
  hasUncommittedChanges(workdir: string): boolean;
}
