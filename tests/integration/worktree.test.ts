import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  assertInsideManagedRoot,
  cleanupWorkdir,
  hasUncommittedChanges,
  prepareWorkdir,
  gitAuthEnv,
  redactSecrets,
  resolveCloneUrl,
  scrubRepoCacheCredentials,
  withRepoLock,
} from "../../src/adapters/git/exec.js";

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
      taskId: "review/one",
      token: "unused",
      cloneUrlOverride: remote,
    });

    assert.equal(
      git(["rev-parse", "--is-inside-work-tree"], handle.path),
      "true",
    );
    assert.equal(existsSync(join(handle.repoCachePath, "HEAD")), true);
    assert.equal(existsSync(join(handle.path, "README.md")), true);
    assert.equal(hasUncommittedChanges(handle.path), false);
    writeFileSync(join(handle.path, "agent-output.txt"), "done\n");
    assert.equal(hasUncommittedChanges(handle.path), true);

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

test("prepareWorkdir fetches the base branch so the PR diff resolves in the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-worktree-base-"));
  try {
    const remote = createBareRemote(root);
    const source = join(root, "source");
    git(["checkout", "-b", "feature"], source);
    writeFileSync(join(source, "feature.txt"), "feature\n");
    git(["add", "feature.txt"], source);
    git(["commit", "-m", "Add feature"], source);
    git(["push", remote, "feature"], source);

    const handle = prepareWorkdir({
      stateDir: join(root, "state"),
      repo: { owner: "owner", repo: "repo" },
      branch: "feature",
      baseBranch: "main",
      taskId: "guide",
      token: "unused",
      cloneUrlOverride: remote,
    });

    assert.equal(
      git(["diff", "--name-only", "origin/main...HEAD"], handle.path),
      "feature.txt",
    );
    cleanupWorkdir(handle, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareWorkdir checks out a pinned commit, fetching it by SHA when the branch moved on", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-worktree-pin-"));
  try {
    const remote = createBareRemote(root);
    const source = join(root, "source");
    const first = git(["rev-parse", "HEAD"], source);
    // A commit only on a pull ref, as after a force push of the PR branch.
    writeFileSync(join(source, "reviewed.txt"), "reviewed\n");
    git(["add", "reviewed.txt"], source);
    git(["commit", "-m", "Reviewed state"], source);
    const reviewed = git(["rev-parse", "HEAD"], source);
    git(["push", remote, "HEAD:refs/pull/1/head"], source);
    git(["reset", "--hard", first], source);
    writeFileSync(join(source, "later.txt"), "later\n");
    git(["add", "later.txt"], source);
    git(["commit", "-m", "Later state"], source);
    const tip = git(["rev-parse", "HEAD"], source);
    git(["push", "--force", remote, "HEAD:main"], source);
    const base = {
      stateDir: join(root, "state"),
      repo: { owner: "owner", repo: "repo" },
      branch: "main",
      token: "unused",
      // file:// makes git copy objects over the transport, not hardlink them.
      cloneUrlOverride: `file://${remote}`,
    };

    const fetched = prepareWorkdir({
      ...base,
      commit: reviewed,
      taskId: "pin",
    });
    assert.equal(git(["rev-parse", "HEAD"], fetched.path), reviewed);
    assert.equal(
      git(["rev-parse", "refs/remotes/origin/main"], fetched.repoCachePath),
      tip,
    );

    const present = prepareWorkdir({ ...base, commit: first, taskId: "old" });
    assert.equal(git(["rev-parse", "HEAD"], present.path), first);

    assert.throws(
      () => prepareWorkdir({ ...base, commit: "f".repeat(40), taskId: "gone" }),
      /Failed to prepare worktree/,
    );
    assert.equal(existsSync(`${fetched.repoCachePath}.lock`), false);
    cleanupWorkdir(fetched, false);
    cleanupWorkdir(present, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withRepoLock waits for a live holder and replaces a dead one", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-repo-lock-"));
  try {
    const cache = join(root, "repos", "o", "r.git");
    const lock = `${cache}.lock`;
    const fast = { timeoutMs: 30, graceMs: 60_000, pollMs: 5 };

    assert.equal(
      withRepoLock(cache, () => existsSync(join(lock, "pid"))),
      true,
    );
    assert.equal(existsSync(lock), false);

    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    assert.throws(() => withRepoLock(cache, () => 1, fast), /timed out/);
    // pid 1 belongs to another user, so signalling it is refused yet it lives.
    writeFileSync(join(lock, "pid"), "1");
    assert.throws(() => withRepoLock(cache, () => 1, fast), /timed out/);

    writeFileSync(join(lock, "pid"), "not a pid");
    assert.equal(
      withRepoLock(cache, () => "dead owner", fast),
      "dead owner",
    );

    mkdirSync(lock);
    assert.throws(() => withRepoLock(cache, () => 1, fast), /timed out/);
    utimesSync(lock, new Date(0), new Date(0));
    assert.equal(
      withRepoLock(cache, () => "orphan", fast),
      "orphan",
    );

    // A lock that vanishes while it is inspected counts as held, not stale.
    symlinkSync(join(root, "nowhere"), lock);
    assert.throws(() => withRepoLock(cache, () => 1, fast), /timed out/);
    rmSync(lock);

    const parent = join(root, "repos", "o");
    chmodSync(parent, 0o500);
    try {
      assert.throws(() => withRepoLock(cache, () => 1, fast), /EACCES/);
    } finally {
      chmodSync(parent, 0o700);
    }
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
              repoCachePath,
            },
            false,
          ),
        /Refusing to operate/,
      );
      assert.equal(existsSync(path), true);
    }

    assert.equal(
      resolveCloneUrl({ owner: "o", repo: "r" }),
      "https://github.com/o/r",
    );
    assert.equal(
      resolveCloneUrl({ owner: "o", repo: "r" }, "/local/repo"),
      "/local/repo",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

const TOKEN = "ghs_0123456789abcdefghijABCDEFGHIJ";

/** Runs fn and returns every console line it wrote. */
function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const methods = ["debug", "log", "warn", "error"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods)
    console[m] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  try {
    fn();
  } finally {
    methods.forEach((m, i) => (console[m] = originals[i]));
  }
  return lines;
}

test("a failing clone reports no token in its error, its cause, or the log", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-clone-leak-"));
  const prompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_TERMINAL_PROMPT = "0";
  try {
    let caught: unknown;
    const lines = captureConsole(() => {
      try {
        prepareWorkdir({
          stateDir: join(root, "state"),
          repo: { owner: "o", repo: "r" },
          branch: "main",
          taskId: "leak",
          token: TOKEN,
          // An old-style credential URL to a closed port fails at once.
          cloneUrlOverride: `https://x-access-token:${TOKEN}@127.0.0.1:1/o/r`,
        });
      } catch (err) {
        caught = err;
      }
    });
    const err = caught as Error & { cause: Error & { stderr: string } };
    assert.match(err.message, /Failed to prepare worktree/);
    const surfaces = [
      err.message,
      String(err.stack),
      err.cause.message,
      String(err.cause.stack),
      err.cause.stderr,
      ...lines,
    ].join("\n");
    assert.doesNotMatch(surfaces, new RegExp(TOKEN));
    assert.match(err.cause.message, /https:\/\/\*\*\*@127\.0\.0\.1:1/);
  } finally {
    if (prompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = prompt;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the token reaches git as a github.com header, never as a URL", () => {
  const env = gitAuthEnv(TOKEN);
  const header = execFileSync(
    "git",
    ["config", "--get", "http.https://github.com/.extraheader"],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  ).trim();
  const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  assert.equal(header, `Authorization: Basic ${encoded}`);
  assert.equal(
    redactSecrets(
      `https://x-access-token:${TOKEN}@github.com/o/r ${TOKEN} github_pat_${"a".repeat(30)} ${header}`,
    ),
    "https://***@github.com/o/r *** *** Authorization: Basic ***",
  );
});

test("scrubRepoCacheCredentials strips credentials from cached remote URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-scrub-"));
  try {
    const stateDir = join(root, "state");
    assert.equal(scrubRepoCacheCredentials(stateDir), 0);
    const repos = join(stateDir, "repos");
    const leaked = join(repos, "acme", "leaked.git");
    const clean = join(repos, "acme", "clean.git");
    const bare = join(repos, "acme", "no-origin.git");
    for (const dir of [leaked, clean, bare])
      git(["init", "--bare", "-q", dir], root);
    git(
      [
        "remote",
        "add",
        "origin",
        `https://x-access-token:${TOKEN}@github.com/acme/leaked`,
      ],
      leaked,
    );
    git(["remote", "add", "origin", "https://github.com/acme/clean"], clean);
    mkdirSync(join(repos, "acme", "not-a-repo"));
    writeFileSync(join(repos, "stray-file"), "");

    assert.equal(scrubRepoCacheCredentials(stateDir), 1);
    assert.equal(
      git(["config", "--get", "remote.origin.url"], leaked),
      "https://github.com/acme/leaked",
    );
    assert.equal(
      git(["config", "--get", "remote.origin.url"], clean),
      "https://github.com/acme/clean",
    );
    assert.equal(scrubRepoCacheCredentials(stateDir), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareWorkdir replaces an old credential URL on an existing cache", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-reset-url-"));
  try {
    const remote = createBareRemote(root);
    const stateDir = join(root, "state");
    const args = {
      stateDir,
      repo: { owner: "o", repo: "r" },
      branch: "main",
      token: TOKEN,
      cloneUrlOverride: remote,
    };
    const first = prepareWorkdir({ ...args, taskId: "one" });
    git(
      [
        "remote",
        "set-url",
        "origin",
        `https://x-access-token:${TOKEN}@github.com/o/r`,
      ],
      first.repoCachePath,
    );
    cleanupWorkdir(first, false);
    const second = prepareWorkdir({ ...args, taskId: "two" });
    assert.equal(
      git(["config", "--get", "remote.origin.url"], second.repoCachePath),
      remote,
    );
    cleanupWorkdir(second, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
