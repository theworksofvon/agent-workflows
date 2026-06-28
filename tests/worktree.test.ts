import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupWorkdir, prepareWorkdir } from "../src/runner/workdir.js";
import {
  commitUncommittedChanges,
  commitsAhead,
  hasUncommittedChanges,
} from "../src/workflows/pr-comment/push.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createBareRemote(root: string): string {
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  git(["init", "-b", "main", source], root);
  git(["config", "user.name", "Test User"], source);
  git(["config", "user.email", "test@example.com"], source);
  writeFileSync(join(source, "README.md"), "# test\n");
  git(["add", "README.md"], source);
  git(["commit", "-m", "Initial commit"], source);
  git(["clone", "--bare", source, remote], root);
  return remote;
}

test("prepareWorkdir uses a cached repo worktree and cleanup removes it", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-worktree-"));
  try {
    const remote = createBareRemote(root);
    const stateDir = join(root, "state");

    const handle = prepareWorkdir({
      stateDir,
      repo: { owner: "local-owner", repo: "sample-repo" },
      branch: "main",
      taskId: "batch/one",
      token: "unused",
      cloneUrlOverride: remote,
    });

    assert.equal(git(["rev-parse", "--is-inside-work-tree"], handle.path), "true");
    assert.equal(existsSync(join(handle.repoCachePath, "HEAD")), true);
    assert.equal(existsSync(join(handle.path, "README.md")), true);

    writeFileSync(join(handle.path, "agent-output.txt"), "done\n");
    assert.equal(hasUncommittedChanges(handle.path), true);
    assert.equal(
      commitUncommittedChanges(handle.path, "Address PR #1 review comments"),
      true,
    );
    assert.equal(hasUncommittedChanges(handle.path), false);
    assert.equal(commitsAhead(handle.path, "main"), 1);

    cleanupWorkdir(handle, false);

    assert.equal(existsSync(handle.path), false);
    assert.equal(git(["branch", "--list", handle.localBranch], handle.repoCachePath), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
