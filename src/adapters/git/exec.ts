import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path, { join, resolve } from "node:path";
import { log } from "../../log.js";
import type { GitPort, WorkdirHandle } from "./git.interface.js";

export type { WorkdirHandle };

interface GitOptions {
  cwd: string;
  /** Sent as an HTTP header through the environment, never in argv or a URL. */
  token?: string;
}

function git(args: string[], opts: GitOptions): string {
  log.debug("git", { args: args.map(redactSecrets), cwd: opts.cwd });
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.token
        ? { ...process.env, ...gitAuthEnv(opts.token) }
        : undefined,
    }).trim();
  } catch (err) {
    throw redactedError(err as GitFailure);
  }
}

/**
 * Git reads these as `-c http.<url>.extraHeader=...`, so the token reaches
 * github.com without a credential URL that Node would copy into an error
 * message or that git would store in the cache's config.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\w+:\/\/)[^\s/@]+@/g, "$1***@"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***"],
  [/(Authorization:\s*(?:Basic|Bearer|token)\s+)\S+/gi, "$1***"],
];

/** Removes URL credentials and token-shaped strings from text. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/**
 * A new error, because the original's stack already holds the raw message.
 * Keeps the fields callers read: status, stdout, and stderr.
 */
function redactedError(err: GitFailure): Error {
  return Object.assign(new Error(redactSecrets(err.message)), {
    status: err.status,
    stdout: redactSecrets(String(err.stdout)),
    stderr: redactSecrets(String(err.stderr)),
  });
}

type GitFailure = Error & {
  status?: number;
  stdout?: unknown;
  stderr?: unknown;
};

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
  baseBranch?: string;
  commit?: string;
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
  const cloneUrl = resolveCloneUrl(repo, args.cloneUrlOverride);
  const localBranch = `agent-workflows/${safeTask}-${Date.now()}`;

  try {
    assertInsideManagedRoot(dir, worktreeBase);
    withRepoLock(repoCachePath, () => {
      ensureRepoCache({
        repoCachePath,
        cloneUrl,
        token,
        branches: args.baseBranch ? [branch, args.baseBranch] : [branch],
      });
      if (args.commit) ensureCommit(repoCachePath, args.commit, token);
      log.info("preparing isolated worktree", {
        dir,
        repo,
        branch,
        commit: args.commit,
      });
      git(
        [
          "worktree",
          "add",
          "-B",
          localBranch,
          dir,
          args.commit ?? `origin/${branch}`,
        ],
        { cwd: repoCachePath },
      );
    });
    return { path: dir, branch, localBranch, repoCachePath };
  } catch (err) {
    // Clean up a half-made worktree so we don't leave junk.
    cleanupPath(dir, worktreeBase);
    throw new Error(
      `Failed to prepare worktree for ${repo.owner}/${repo.repo}:${branch}: ${String(err)}`,
      { cause: err },
    );
  }
}

/** Remove the worktree unless KEEP_WORKDIRS is set. */
export function cleanupWorkdir(handle: WorkdirHandle, keep: boolean): void {
  if (keep) {
    log.debug("keeping worktree for debugging", { path: handle.path });
    return;
  }
  const worktreeRoot = resolve(
    handle.repoCachePath,
    "..",
    "..",
    "..",
    "worktrees",
  );
  assertInsideManagedRoot(handle.path, worktreeRoot);
  withRepoLock(handle.repoCachePath, () =>
    removeWorktree(handle, worktreeRoot),
  );
}

function removeWorktree(handle: WorkdirHandle, worktreeRoot: string): void {
  try {
    git(["worktree", "remove", "--force", handle.path], {
      cwd: handle.repoCachePath,
    });
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
  token: string;
  branches: string[];
}): void {
  const { repoCachePath, cloneUrl, token, branches } = args;
  if (!existsSync(repoCachePath)) {
    mkdirSync(resolve(repoCachePath, ".."), { recursive: true });
    log.info("creating cached bare repo", { repoCachePath });
    git(["clone", "--bare", cloneUrl, repoCachePath], {
      cwd: resolve(repoCachePath, ".."),
      token,
    });
  } else {
    // Also replaces a credential URL that an older version stored.
    git(["remote", "set-url", "origin", cloneUrl], { cwd: repoCachePath });
  }
  git(
    [
      "fetch",
      "--prune",
      "origin",
      ...branches.map(
        (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ),
    ],
    { cwd: repoCachePath, token },
  );
}

/** Makes `commit` present in the cache, fetching it by SHA when needed. */
function ensureCommit(
  repoCachePath: string,
  commit: string,
  token: string,
): void {
  try {
    git(["cat-file", "-e", `${commit}^{commit}`], { cwd: repoCachePath });
  } catch {
    log.info("fetching the pinned commit by SHA", { commit });
    git(["fetch", "origin", commit], { cwd: repoCachePath, token });
  }
}

/**
 * Older versions stored `https://x-access-token:<token>@github.com/...` as
 * each cache's origin. Rewrites every such URL without its credentials and
 * returns how many it rewrote.
 */
export function scrubRepoCacheCredentials(stateDir: string): number {
  const reposRoot = join(resolve(stateDir), "repos");
  let scrubbed = 0;
  for (const cache of bareRepos(reposRoot)) {
    let url: string;
    try {
      url = git(["config", "--get", "remote.origin.url"], { cwd: cache });
    } catch {
      continue;
    }
    const clean = url.replace(/^(\w+:\/\/)[^/@]+@/, "$1");
    if (clean === url) continue;
    git(["remote", "set-url", "origin", clean], { cwd: cache });
    log.info("removed credentials from a cached repo's remote URL", { cache });
    scrubbed += 1;
  }
  return scrubbed;
}

function bareRepos(reposRoot: string): string[] {
  if (!existsSync(reposRoot)) return [];
  return readdirSync(reposRoot, { withFileTypes: true })
    .filter((owner) => owner.isDirectory())
    .flatMap((owner) =>
      readdirSync(join(reposRoot, owner.name), { withFileTypes: true })
        .filter((repo) => repo.isDirectory() && repo.name.endsWith(".git"))
        .map((repo) => join(reposRoot, owner.name, repo.name)),
    );
}

export interface RepoLockOptions {
  /** Give up after waiting this long for a live holder. */
  timeoutMs: number;
  /** A lock without an owner pid this old was left by a crash. */
  graceMs: number;
  pollMs: number;
}

const REPO_LOCK: RepoLockOptions = {
  timeoutMs: 15 * 60_000,
  graceMs: 10_000,
  pollMs: 250,
};

/**
 * Runs `fn` while holding a lock directory beside the bare repo cache. Git
 * refuses concurrent ref updates ("cannot lock ref"), and the app and a
 * `review` run can share one cache. Inside one process the calls are already
 * serial, because every git call is synchronous.
 */
export function withRepoLock<T>(
  repoCachePath: string,
  fn: () => T,
  opts: RepoLockOptions = REPO_LOCK,
): T {
  const lockPath = `${repoCachePath}.lock`;
  mkdirSync(resolve(lockPath, ".."), { recursive: true });
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (lockIsStale(lockPath, opts.graceMs)) {
      log.warn("removing a stale repo cache lock", { lockPath });
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for the repo cache lock ${lockPath}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.pollMs);
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** A lock is stale when its owner is gone, or it never got an owner. */
function lockIsStale(lockPath: string, graceMs: number): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(lockPath, "pid"), "utf8"));
  } catch {
    // The holder has not written its pid yet, or just released the lock.
    return Date.now() - lockTime(lockPath) > graceMs;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

function lockTime(lockPath: string): number {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return Date.now();
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "task";
}

/** Never carries credentials: git() sends the token as a header. */
export function resolveCloneUrl(
  repo: { owner: string; repo: string },
  override?: string,
): string {
  return override ?? `https://github.com/${repo.owner}/${repo.repo}`;
}

export function assertInsideManagedRoot(
  candidatePath: string,
  root: string,
  pathFlavor: Pick<
    typeof path,
    "isAbsolute" | "relative" | "resolve" | "sep"
  > = path,
): void {
  const resolvedPath = pathFlavor.resolve(candidatePath);
  const resolvedRoot = pathFlavor.resolve(root);
  const rel = pathFlavor.relative(resolvedRoot, resolvedPath);
  const unsafe = [
    rel === "",
    rel === "..",
    rel.startsWith(`..${pathFlavor.sep}`),
    pathFlavor.isAbsolute(rel),
  ].includes(true);
  if (unsafe) {
    throw new Error(
      `Refusing to operate outside managed worktree root: ${resolvedPath}`,
    );
  }
}

function cleanupPath(path: string, root: string): void {
  if (!existsSync(path)) return;
  assertInsideManagedRoot(path, root);
  rmSync(path, { recursive: true, force: true });
}

export function hasUncommittedChanges(workdir: string): boolean {
  return git(["status", "--porcelain"], { cwd: workdir }) !== "";
}

export const gitExec: GitPort = {
  prepareWorkdir,
  cleanupWorkdir,
  hasUncommittedChanges,
};
