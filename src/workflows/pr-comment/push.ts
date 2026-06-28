import { execFileSync } from "node:child_process";
import { log } from "../../log.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Count commits on the branch ahead of origin. */
export function commitsAhead(workdir: string, branch: string): number {
  try {
    const out = git(["rev-list", "--count", "HEAD", `^origin/${branch}`], workdir);
    return Number(out) || 0;
  } catch {
    // origin/HEAD may not exist; fall back to status.
    const status = git(["status", "--porcelain"], workdir);
    return status === "" ? 0 : 1;
  }
}

export function hasUncommittedChanges(workdir: string): boolean {
  return git(["status", "--porcelain"], workdir) !== "";
}

export function commitUncommittedChanges(workdir: string, message: string): boolean {
  if (!hasUncommittedChanges(workdir)) return false;
  log.info("committing uncommitted agent changes", { message });
  git(["add", "-A"], workdir);
  git(["commit", "-m", message], workdir);
  return true;
}

/**
 * Push the branch back to origin. Uses force-with-lease to be safe against
 * a teammate pushing in between our fetch and push.
 */
export function pushBranch(workdir: string, branch: string): void {
  log.info("pushing branch to origin", { branch });
  git(["push", "--force-with-lease", "origin", `HEAD:${branch}`], workdir);
}
