import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.js";

export interface WorkdirHandle {
  /** Absolute path to the checkout. */
  path: string;
  /** Branch checked out. */
  branch: string;
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
 * Create an isolated checkout of a PR branch. Clones shallowly, fetches the
 * branch, and checks it out. Never touches the user's dev checkout.
 */
export function prepareWorkdir(args: {
  stateDir: string;
  repo: { owner: string; repo: string };
  branch: string;
  taskId: string;
  token: string;
}): WorkdirHandle {
  const { repo, branch, taskId, token, stateDir } = args;
  const base = join(stateDir, "workdirs");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${taskId}-`));

  const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}`;

  try {
    log.info("preparing isolated workdir", { dir, repo, branch });
    // Shallow clone of just the target branch.
    git(
      ["clone", "--depth", "1", "--branch", branch, "--single-branch", cloneUrl, dir],
      { cwd: tmpdir() },
    );
    // Ensure git identity is set for commits the agent makes.
    git(["config", "user.name", "agent-workflows"], { cwd: dir });
    git(["config", "user.email", "agent-workflows@users.noreply.github.com"], { cwd: dir });
    return { path: dir, branch };
  } catch (err) {
    // Clean up a half-made clone so we don't leave junk.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to prepare workdir for ${repo.owner}/${repo.repo}:${branch}: ${String(err)}`);
  }
}

/** Remove the workdir unless KEEP_WORKDIRS is set. */
export function cleanupWorkdir(handle: WorkdirHandle, keep: boolean): void {
  if (keep) {
    log.debug("keeping workdir for debugging", { path: handle.path });
    return;
  }
  rmSync(handle.path, { recursive: true, force: true });
}
