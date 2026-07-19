import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  assertInsideManagedRoot,
  cleanupWorkdir,
  prepareWorkdir,
  resolveCloneUrl,
} from "../src/runner/workdir.js";
import {
  commitUncommittedChanges,
  commitsAhead,
  hasUncommittedChanges,
  pushBranch,
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

    assert.equal(
      git(["rev-parse", "--is-inside-work-tree"], handle.path),
      "true",
    );
    assert.equal(existsSync(join(handle.repoCachePath, "HEAD")), true);
    assert.equal(existsSync(join(handle.path, "README.md")), true);
    assert.match(handle.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(commitsAhead(handle.path, "main"), 0);

    writeFileSync(join(handle.path, "agent-output.txt"), "done\n");
    assert.equal(hasUncommittedChanges(handle.path), true);
    assert.equal(
      commitUncommittedChanges(handle.path, "Address PR #1 review comments"),
      true,
    );
    assert.equal(hasUncommittedChanges(handle.path), false);
    assert.equal(commitsAhead(handle.path, "main"), 1);
    pushBranch(handle.path, "main", handle.baseSha);
    assert.equal(
      git(["rev-parse", "main"], remote),
      git(["rev-parse", "HEAD"], handle.path),
    );

    cleanupWorkdir(handle, false);

    assert.equal(existsSync(handle.path), false);
    assert.equal(
      git(["branch", "--list", handle.localBranch], handle.repoCachePath),
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushBranch rejects when the remote branch moved after worktree creation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-worktree-stale-"));
  try {
    const remote = createBareRemote(root);
    const stateDir = join(root, "state");

    const handle = prepareWorkdir({
      stateDir,
      repo: { owner: "local-owner", repo: "sample-repo" },
      branch: "main",
      taskId: "batch/two",
      token: "unused",
      cloneUrlOverride: remote,
    });

    const other = join(root, "other");
    git(["clone", remote, other], root);
    git(["config", "user.name", "Other User"], other);
    git(["config", "user.email", "other@example.com"], other);
    writeFileSync(join(other, "remote-change.txt"), "remote moved\n");
    git(["add", "remote-change.txt"], other);
    git(["commit", "-m", "Move remote branch"], other);
    git(["push", "origin", "main"], other);

    writeFileSync(join(handle.path, "agent-output.txt"), "done\n");
    assert.equal(
      commitUncommittedChanges(handle.path, "Address PR #1 review comments"),
      true,
    );
    assert.throws(
      () => pushBranch(handle.path, "main", handle.baseSha),
      /Command failed: git push/,
    );

    cleanupWorkdir(handle, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workdir helpers sanitize tasks, retain requested worktrees, and clean up fallback paths", () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-workflows-worktree-branches-"),
  );
  try {
    const remote = createBareRemote(root);
    const handle = prepareWorkdir({
      stateDir: join(root, "state"),
      repo: { owner: "local owner", repo: "sample/repo" },
      branch: "main",
      taskId: "",
      token: "unused",
      cloneUrlOverride: remote,
    });
    assert.match(handle.localBranch, /^agent-workflows\/task-/);
    cleanupWorkdir(handle, true);
    assert.equal(existsSync(handle.path), true);
    cleanupWorkdir(handle, false);
    cleanupWorkdir(handle, false);
    assert.equal(existsSync(handle.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareWorkdir wraps checkout failures and removes partial directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-worktree-failure-"));
  try {
    const remote = createBareRemote(root);
    assert.throws(
      () =>
        prepareWorkdir({
          stateDir: join(root, "state"),
          repo: { owner: "owner", repo: "repo" },
          branch: "missing-branch",
          taskId: "failure",
          token: "unused",
          cloneUrlOverride: remote,
        }),
      /Failed to prepare worktree/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed path and clone URL helpers reject broad targets without external access", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-workflows-containment-"));
  try {
    const stateRoot = join(temp, "state");
    const managedRoot = join(stateRoot, "worktrees");
    const sibling = join(stateRoot, "worktrees-sibling");
    const outside = join(temp, "outside");
    for (const path of [managedRoot, sibling, outside]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "marker"), "must survive");
    }

    assert.doesNotThrow(() =>
      assertInsideManagedRoot(join(managedRoot, "child"), managedRoot),
    );
    for (const path of [managedRoot, sibling, outside]) {
      assert.throws(
        () => assertInsideManagedRoot(path, managedRoot),
        /Refusing to operate/,
      );
      assert.equal(existsSync(path), true);
    }

    const windowsRoot = "C:\\state\\worktrees";
    assert.doesNotThrow(() =>
      assertInsideManagedRoot(
        "C:\\state\\worktrees\\child",
        windowsRoot,
        win32,
      ),
    );
    for (const path of [
      windowsRoot,
      "C:\\state\\worktrees-sibling",
      "D:\\outside",
    ]) {
      assert.throws(
        () => assertInsideManagedRoot(path, windowsRoot, win32),
        /Refusing to operate/,
      );
    }

    const repoCachePath = join(stateRoot, "repos", "owner", "repo.git");
    for (const path of [managedRoot, sibling, outside]) {
      assert.throws(
        () =>
          cleanupWorkdir(
            {
              path,
              branch: "main",
              localBranch: "local",
              baseSha: "abc",
              repoCachePath,
            },
            false,
          ),
        /Refusing to operate/,
      );
      assert.equal(existsSync(path), true);
    }

    assert.equal(
      resolveCloneUrl({ owner: "o", repo: "r" }, "secret"),
      "https://x-access-token:secret@github.com/o/r",
    );
    assert.equal(
      resolveCloneUrl({ owner: "o", repo: "r" }, "secret", "/local/repo"),
      "/local/repo",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("commitsAhead falls back to worktree status when the origin branch is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-ahead-fallback-"));
  try {
    git(["init", "-b", "main", root], tmpdir());
    git(["config", "user.name", "Test"], root);
    git(["config", "user.email", "test@example.com"], root);
    assert.equal(commitsAhead(root, "missing"), 0);
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    assert.equal(commitsAhead(root, "missing"), 1);
    assert.equal(commitUncommittedChanges(root, "commit dirty"), true);
    assert.equal(commitUncommittedChanges(root, "nothing"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
