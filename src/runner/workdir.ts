import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { log } from "../log.js";

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

function git(args: string[], opts: { cwd: string }): string {
  log.debug("git", { args, cwd: opts.cwd });
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create an isolated checkout of a PR branch using git worktrees.
 *
 * The first task for a repo creates a cached bare repo at:
 *   state/repos/<owner>/<repo>.git
 *
 * Each task then gets its own worktree at:
 *   state/worktrees/<owner>/<repo>/<task-id>...
 *
 * This keeps agent sessions isolated without repeatedly cloning the full repo.
 */
export function prepareWorkdir(args: {
  stateDir: string;
  repo: { owner: string; repo: string };
  branch: string;
  taskId: string;
  token: string;
  cloneUrlOverride?: string;
}): WorkdirHandle {
  const { repo, branch, taskId, token, stateDir } = args;
  const safeOwner = safePathSegment(repo.owner);
  const safeRepo = safePathSegment(repo.repo);
  const safeTask = safePathSegment(taskId);
  const stateRoot = resolve(stateDir);
  const repoCachePath = join(stateRoot, "repos", safeOwner, `${safeRepo}.git`);
  const worktreeBase = join(stateRoot, "worktrees", safeOwner, safeRepo);
  mkdirSync(worktreeBase, { recursive: true });
  const dir = mkdtempSync(join(worktreeBase, `${safeTask}-`));
  const cloneUrl =
    args.cloneUrlOverride ??
    `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}`;
  const localBranch = `agent-workflows/${safeTask}-${Date.now()}`;

  try {
    ensureInside(dir, worktreeBase);
    ensureRepoCache({ repoCachePath, cloneUrl, branch });
    const baseSha = git(["rev-parse", `refs/remotes/origin/${branch}`], {
      cwd: repoCachePath,
    });
    log.info("preparing isolated worktree", { dir, repo, branch });
    git(["worktree", "add", "-B", localBranch, dir, `origin/${branch}`], {
      cwd: repoCachePath,
    });
    // Ensure git identity is set for commits the agent makes.
    git(["config", "user.name", "agent-workflows"], { cwd: dir });
    git(["config", "user.email", "agent-workflows@users.noreply.github.com"], { cwd: dir });
    return { path: dir, branch, localBranch, baseSha, repoCachePath };
  } catch (err) {
    // Clean up a half-made worktree so we don't leave junk.
    cleanupPath(dir, worktreeBase);
    throw new Error(`Failed to prepare worktree for ${repo.owner}/${repo.repo}:${branch}: ${String(err)}`);
  }
}

/** Remove the worktree unless KEEP_WORKDIRS is set. */
export function cleanupWorkdir(handle: WorkdirHandle, keep: boolean): void {
  if (keep) {
    log.debug("keeping worktree for debugging", { path: handle.path });
    return;
  }
  const worktreeRoot = resolve(handle.repoCachePath, "..", "..", "..", "worktrees");
  ensureInside(handle.path, worktreeRoot);
  try {
    git(["worktree", "remove", "--force", handle.path], { cwd: handle.repoCachePath });
    git(["worktree", "prune"], { cwd: handle.repoCachePath });
    deleteLocalBranch(handle);
  } catch (err) {
    log.warn("git worktree remove failed, removing path directly", {
      path: handle.path,
      error: String(err),
    });
    cleanupPath(handle.path, worktreeRoot);
    git(["worktree", "prune"], { cwd: handle.repoCachePath });
    deleteLocalBranch(handle);
  }
}

function deleteLocalBranch(handle: WorkdirHandle): void {
  try {
    git(["branch", "-D", handle.localBranch], { cwd: handle.repoCachePath });
  } catch (err) {
    log.warn("failed to delete temporary worktree branch", {
      branch: handle.localBranch,
      error: String(err),
    });
  }
}

function ensureRepoCache(args: {
  repoCachePath: string;
  cloneUrl: string;
  branch: string;
}): void {
  const { repoCachePath, cloneUrl, branch } = args;
  if (!existsSync(repoCachePath)) {
    mkdirSync(resolve(repoCachePath, ".."), { recursive: true });
    log.info("creating cached bare repo", { repoCachePath });
    git(["clone", "--bare", cloneUrl, repoCachePath], { cwd: resolve(repoCachePath, "..") });
  } else {
    git(["remote", "set-url", "origin", cloneUrl], { cwd: repoCachePath });
  }
  git(["fetch", "--prune", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: repoCachePath,
  });
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "task";
}

function ensureInside(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith("..") || rel === "" || resolve(resolvedRoot, rel) !== resolvedPath) {
    throw new Error(`Refusing to operate outside managed worktree root: ${resolvedPath}`);
  }
}

function cleanupPath(path: string, root: string): void {
  if (!existsSync(path)) return;
  ensureInside(path, root);
  rmSync(path, { recursive: true, force: true });
}
