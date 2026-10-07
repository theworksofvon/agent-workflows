import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../src/config.js";
import type {
  AgentAdapter,
  AgentRunInput,
} from "../../src/adapters/agent/agent.interface.js";
import type {
  GitPort,
  WorkdirHandle,
} from "../../src/adapters/git/git.interface.js";
import type { PullDetail } from "../../src/domain/inbox.js";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import {
  sqliteReviewSessions,
  type ReviewSessionStore,
} from "../../src/adapters/state/review-sessions.js";
import type {
  PullRequestFile,
  RepoRef,
} from "../../src/domain/pull-request.js";
import {
  runGuidedReview,
  type GuidedReviewDeps,
} from "../../src/services/guided-review.js";
import { ServerStoppedError } from "../../src/domain/errors.js";

const repo: RepoRef = { owner: "acme", repo: "shop" };

const FILES: PullRequestFile[] = [
  {
    path: "src/refunds.ts",
    status: "added",
    additions: 20,
    deletions: 0,
    patch: "+export const PATCH_MARKER = 1;",
  },
  {
    path: "src/refunds.test.ts",
    status: "added",
    additions: 10,
    deletions: 0,
    patch: "+test()",
  },
];

const GUIDE = {
  overview: {
    context: "Adds refunds.",
    steps: ["Add refund", "Test it", "Ship it"],
    flows: [],
  },
  chapters: [
    {
      id: "c1",
      title: "Refunds",
      role: "core",
      summary: "Adds the refund function.",
      files: ["src/refunds.ts"],
    },
    {
      id: "c2",
      title: "Tests",
      role: "tests",
      summary: "Covers refunds.",
      files: ["src/refunds.test.ts"],
    },
  ],
};

const PRIMARY = {
  summary: "primary",
  findings: [
    { path: "src/refunds.ts", line: 1, body: "bug", severity: "medium" },
  ],
};
const ADVERSARIAL = { summary: "adversarial", findings: [] };

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    githubToken: "t",
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    stateDir: join(root, "state"),
    claudeCodeBin: "c",
    codexBin: "x",
    keepWorkdirs: false,
    maxConcurrentRuns: 3,
    uiHost: "127.0.0.1",
    uiPort: 4773,
    uiPublicPort: 4773,
    ...overrides,
  };
}

type Kind = "guide" | "review";
/** Returns the report text for an attempt (1-based), or null to write nothing. */
type Writer = (attempt: number) => string | null;

interface FakeAgent extends AgentAdapter {
  prompts: Record<Kind, string[]>;
}

function json(value: unknown): Writer {
  return () => JSON.stringify(value);
}

function fakeAgent(
  name: string,
  writers: Partial<Record<Kind, Writer>>,
  opts: { exitCode?: Partial<Record<Kind, number>> } = {},
): FakeAgent {
  const prompts: Record<Kind, string[]> = { guide: [], review: [] };
  return {
    name,
    prompts,
    async run(input: AgentRunInput) {
      const kind: Kind = input.prompt.includes("guided review")
        ? "guide"
        : "review";
      prompts[kind].push(input.prompt);
      const reportPath =
        /write JSON to (\S+) with this shape/.exec(input.prompt)?.[1] ??
        /described by that skill to (\S+) before/.exec(input.prompt)?.[1] ??
        /report at (\S+) is missing/.exec(input.prompt)?.[1];
      const text = writers[kind]?.(prompts[kind].length) ?? null;
      if (reportPath && text !== null) writeFileSync(reportPath, text);
      return { exitCode: opts.exitCode?.[kind] ?? 0, stdout: "", stderr: "" };
    },
  };
}

interface GitCalls {
  prepared: Array<Parameters<GitPort["prepareWorkdir"]>[0]>;
  cleanups: Array<{ path: string; keep: boolean }>;
}

/** Each prepared worktree is a directory named after the role in its task id. */
function fakeGit(
  root: string,
  opts: { dirty?: (role: string) => boolean; cleanupError?: Error } = {},
): GitPort & { calls: GitCalls } {
  const calls: GitCalls = { prepared: [], cleanups: [] };
  return {
    calls,
    prepareWorkdir: (args) => {
      calls.prepared.push(args);
      const role = args.taskId.split(":").at(-1)!;
      const path = join(root, `wt-${role}`);
      mkdirSync(path, { recursive: true });
      return {
        path,
        branch: args.branch,
        localBranch: "l",
        repoCachePath: root,
      } satisfies WorkdirHandle;
    },
    cleanupWorkdir: (handle, keep) => {
      calls.cleanups.push({ path: handle.path, keep });
      if (opts.cleanupError) throw opts.cleanupError;
    },
    hasUncommittedChanges: (workdir) =>
      opts.dirty?.(workdir.slice(workdir.lastIndexOf("wt-") + 3)) ?? false,
  };
}

function roles(git: ReturnType<typeof fakeGit>): string[] {
  return git.calls.prepared.map((args) => args.taskId.split(":").at(-1)!);
}

function cleanedRoles(git: ReturnType<typeof fakeGit>): string[] {
  return git.calls.cleanups.map(({ path }) =>
    path.slice(path.lastIndexOf("wt-") + 3),
  );
}

function details(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    repo,
    number: 42,
    title: "Add refunds",
    body: "Refund support.",
    headRef: "feat/refunds",
    baseRef: "main",
    state: "draft",
    fromFork: false,
    author: { login: "alice", avatarUrl: "https://avatars.test/alice" },
    url: "https://github.com/acme/shop/pull/42",
    headSha: "deadbeef",
    reviewDecision: null,
    updatedAt: "2026-10-07T00:00:00Z",
    lastCommit: {
      authorLogin: "bob",
      authorName: "Bob",
      committedAt: "2026-10-06T00:00:00Z",
    },
    checks: "passing",
    additions: 4,
    deletions: 0,
    changedFiles: 2,
    ...overrides,
  };
}

interface Harness {
  root: string;
  db: DatabaseSync;
  sessions: ReviewSessionStore;
  sessionId: string;
  git: ReturnType<typeof fakeGit>;
  deps: GuidedReviewDeps;
  /** The logins the run asked GitHub access for. */
  accounts: string[];
  runDir: string;
  close(): void;
}

function harness(
  opts: {
    agent?: FakeAgent;
    adversarialAgent?: FakeAgent;
    git?: (root: string) => ReturnType<typeof fakeGit>;
    files?: PullRequestFile[];
    githubError?: unknown;
    details?: Partial<PullDetail>;
    config?: Partial<Config>;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "guided-review-"));
  const cfg = config(root, opts.config);
  const db = openStateDatabase(cfg.stateDir);
  const sessions = sqliteReviewSessions(db);
  const session = sessions.create({
    repo,
    prNumber: 42,
    agent: "fake",
    account: "alice",
  });
  const git = (opts.git ?? ((r) => fakeGit(r)))(root);
  const accounts: string[] = [];
  const deps: GuidedReviewDeps = {
    config: cfg,
    github: {
      async use(login) {
        accounts.push(login);
        return {
          token: `token-of-${login}`,
          client: {
            async getPullRequestDetail() {
              if (opts.githubError !== undefined) throw opts.githubError;
              return details(opts.details);
            },
            async listPullRequestFiles() {
              return opts.files ?? FILES;
            },
          },
        };
      },
    },
    git,
    sessions,
    agent:
      opts.agent ??
      fakeAgent("primary", { guide: json(GUIDE), review: json(PRIMARY) }),
    adversarialAgent:
      opts.adversarialAgent ??
      fakeAgent("adversarial", { review: json(ADVERSARIAL) }),
  };
  return {
    root,
    db,
    sessions,
    sessionId: session.id,
    git,
    deps,
    accounts,
    runDir: join(cfg.stateDir, "runs", `guide_${session.id}`),
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a guided review records the PR, triage, guide, and review, then cleans up", async () => {
  const agent = fakeAgent("primary", {
    guide: json(GUIDE),
    review: json(PRIMARY),
  });
  const adversarial = fakeAgent("adversarial", { review: json(ADVERSARIAL) });
  const h = harness({ agent, adversarialAgent: adversarial });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "ready");
    assert.equal(s.stage, "Ready");
    assert.equal(s.error, null);
    assert.deepEqual(s.pr, {
      title: "Add refunds",
      body: "Refund support.",
      author: "alice",
      authorAvatarUrl: "https://avatars.test/alice",
      state: "draft",
      lastCommit: {
        authorLogin: "bob",
        authorName: "Bob",
        committedAt: "2026-10-06T00:00:00Z",
      },
      url: "https://github.com/acme/shop/pull/42",
      headRef: "feat/refunds",
      baseRef: "main",
      headSha: "deadbeef",
      files: FILES,
    });
    // The session's account fetches the PR, and its token clones.
    assert.deepEqual(h.accounts, ["alice"]);
    assert.deepEqual(
      new Set(h.git.calls.prepared.map((p) => p.token)),
      new Set(["token-of-alice"]),
    );
    assert.equal(s.triage?.depth, "light");
    assert.equal(s.triage?.engine, "heuristic");
    assert.equal(s.guide.error, null);
    assert.deepEqual(
      s.guide.value?.chapters.map((c) => c.id),
      ["c1", "c2"],
    );
    assert.deepEqual(s.review, {
      value: PRIMARY,
      error: null,
      adversarial: false,
    });
    assert.equal(adversarial.prompts.review.length, 0);

    assert.deepEqual(roles(h.git), ["guide", "review"]);
    for (const prepared of h.git.calls.prepared) {
      assert.equal(prepared.branch, "feat/refunds");
      assert.equal(prepared.baseBranch, "main");
      assert.equal(prepared.commit, "deadbeef");
    }
    assert.equal(
      h.git.calls.prepared[0].taskId,
      `guide:acme/shop:pr:42:${h.sessionId.slice(0, 8)}:guide`,
    );
    assert.deepEqual(cleanedRoles(h.git), ["guide", "review"]);
    assert.ok(h.git.calls.cleanups.every(({ keep }) => !keep));
    assert.equal(existsSync(h.runDir), false);

    const guidePrompt = agent.prompts.guide[0];
    assert.ok(guidePrompt.includes(join(h.runDir, "guide.json")));
    assert.ok(guidePrompt.includes("git diff origin/main...HEAD"));
    assert.ok(!guidePrompt.includes("PATCH_MARKER"));
    const reviewPrompt = agent.prompts.review[0];
    assert.ok(reviewPrompt.includes(join(h.runDir, "primary-report.json")));
    assert.ok(reviewPrompt.includes("PATCH_MARKER"));
  } finally {
    h.close();
  }
});

test("a failed guide still leaves the session ready with the review", async () => {
  const h = harness({
    agent: fakeAgent("primary", {
      guide: () => "not json",
      review: json(PRIMARY),
    }),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "ready");
    assert.equal(s.guide.value, null);
    assert.match(s.guide.error!, /guide is not valid JSON/);
    assert.deepEqual(s.review.value, PRIMARY);
  } finally {
    h.close();
  }
});

test("when the guide and the review both fail the session fails with both messages", async () => {
  const h = harness({
    agent: fakeAgent(
      "primary",
      { guide: () => "not json", review: json(PRIMARY) },
      { exitCode: { review: 3 } },
    ),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "failed");
    assert.match(s.review.error!, /Primary review agent exited 3/);
    assert.match(s.error!, /Guide: .*guide is not valid JSON/);
    assert.match(s.error!, /Review: .*Primary review agent exited 3/);
    assert.deepEqual(cleanedRoles(h.git), ["guide", "review"]);
  } finally {
    h.close();
  }
});

test("a GitHub failure fails the session before any checkout", async () => {
  const h = harness({ githubError: new Error("404 Not Found") });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "failed");
    assert.equal(s.error, "404 Not Found");
    assert.equal(s.pr, null);
    assert.equal(h.git.calls.prepared.length, 0);
    assert.deepEqual(h.git.calls.cleanups, []);
  } finally {
    h.close();
  }
});

test("a thrown non-Error value is recorded as text", async () => {
  const h = harness({ githubError: "rate limited" });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    assert.equal(h.sessions.get(h.sessionId)!.error, "rate limited");
  } finally {
    h.close();
  }
});

test("a deep triage runs the adversarial review even when the mode is off", async () => {
  // 800 changed lines make the heuristic triage deep.
  const files = FILES.map((f, i) => (i === 0 ? { ...f, additions: 800 } : f));
  const adversarial = fakeAgent("adversarial", { review: json(ADVERSARIAL) });
  const h = harness({ files, adversarialAgent: adversarial });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.triage?.depth, "deep");
    assert.equal(s.stage, "Ready");
    assert.deepEqual(s.review, {
      value: ADVERSARIAL,
      error: null,
      adversarial: true,
    });
    assert.deepEqual(roles(h.git), ["guide", "review"]);
    assert.deepEqual(cleanedRoles(h.git), ["guide", "review"]);
    const prompt = adversarial.prompts.review[0];
    assert.ok(prompt.includes(join(h.runDir, "adversarial-report.json")));
    assert.match(prompt, /Review role: adversarial/);
  } finally {
    h.close();
  }
});

test("the configured adversarial mode also triggers the adversarial review", async () => {
  const h = harness({ config: { reviewAdversarialMode: "always" } });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.triage?.depth, "light");
    assert.equal(s.review.adversarial, true);
    assert.deepEqual(s.review.value, ADVERSARIAL);
  } finally {
    h.close();
  }
});

test("a failed adversarial pass keeps the primary review and notes the failure", async () => {
  const h = harness({
    config: { reviewAdversarialMode: "always" },
    adversarialAgent: fakeAgent(
      "adversarial",
      { review: json(ADVERSARIAL) },
      { exitCode: { review: 1 } },
    ),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "ready");
    assert.deepEqual(s.review.value, PRIMARY);
    assert.equal(s.review.adversarial, false);
    assert.match(s.review.error!, /Adversarial review agent exited 1/);
  } finally {
    h.close();
  }
});

test("a missing guide is requested once more", async () => {
  const agent = fakeAgent("primary", {
    guide: (attempt) => (attempt === 2 ? JSON.stringify(GUIDE) : null),
    review: json(PRIMARY),
  });
  const h = harness({ agent });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(agent.prompts.guide.length, 2);
    assert.match(agent.prompts.guide[1], /is missing/);
    assert.equal(s.guide.error, null);
    assert.equal(s.guide.value?.chapters.length, 2);
  } finally {
    h.close();
  }
});

test("a guide that is still missing after the relaunch is a guide error", async () => {
  const h = harness({
    agent: fakeAgent("primary", { review: json(PRIMARY) }),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "ready");
    assert.match(s.guide.error!, /agent produced no report/);
  } finally {
    h.close();
  }
});

test("an agent that modifies its own worktree is refused without failing the other agent", async () => {
  const h = harness({
    git: (root) => fakeGit(root, { dirty: (r) => r === "guide" }),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "ready");
    assert.match(s.guide.error!, /Guide agent modified files/);
    assert.deepEqual(s.review.value, PRIMARY);
  } finally {
    h.close();
  }
});

test("when both agents modify their worktrees both reports are refused", async () => {
  const h = harness({ git: (root) => fakeGit(root, { dirty: () => true }) });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "failed");
    assert.match(s.guide.error!, /Guide agent modified files/);
    assert.match(s.review.error!, /Primary review agent modified files/);
  } finally {
    h.close();
  }
});

test("a pull request from a fork is refused before any checkout", async () => {
  const h = harness({ details: { fromFork: true, headRef: "main" } });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const s = h.sessions.get(h.sessionId)!;
    assert.equal(s.status, "failed");
    assert.match(s.error!, /acme\/shop#42 comes from a fork/);
    assert.equal(s.pr?.title, "Add refunds");
    assert.equal(h.git.calls.prepared.length, 0);
  } finally {
    h.close();
  }
});

test("a large PR sends the reviewer to the local diff instead of patches", async () => {
  const many: PullRequestFile[] = Array.from({ length: 41 }, (_, i) => ({
    path: `src/f${i}.ts`,
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: `+PATCH_MARKER_${i}`,
  }));
  const agent = fakeAgent("primary", {
    guide: json(GUIDE),
    review: json(PRIMARY),
  });
  const h = harness({ agent, files: many });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    const prompt = agent.prompts.review[0];
    assert.ok(!prompt.includes("PATCH_MARKER"));
    assert.match(prompt, /Patch omitted/);
    assert.ok(
      prompt.includes(
        "Run `git diff origin/main...HEAD` to see the full change.",
      ),
    );
  } finally {
    h.close();
  }
});

test("a PR with too many changed lines also omits patches", async () => {
  const big: PullRequestFile[] = [{ ...FILES[0], additions: 3001 }];
  const agent = fakeAgent("primary", {
    guide: json(GUIDE),
    review: json(PRIMARY),
  });
  const h = harness({ agent, files: big });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    assert.match(agent.prompts.review[0], /Patch omitted/);
  } finally {
    h.close();
  }
});

test("keepWorkdirs keeps the worktree and the run dir", async () => {
  const h = harness({ config: { keepWorkdirs: true } });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    assert.ok(h.git.calls.cleanups.every(({ keep }) => keep));
    assert.equal(h.git.calls.cleanups.length, 2);
    assert.equal(existsSync(join(h.runDir, "guide.json")), true);
    assert.equal(existsSync(join(h.runDir, "primary-report.json")), true);
  } finally {
    h.close();
  }
});

test("a cleanup failure does not escape or change the result", async () => {
  const h = harness({
    git: (root) =>
      fakeGit(root, { cleanupError: new Error("worktree locked") }),
  });
  try {
    await runGuidedReview(h.sessionId, h.deps);

    assert.equal(h.sessions.get(h.sessionId)!.status, "ready");
    assert.deepEqual(cleanedRoles(h.git), ["guide", "review"]);
  } finally {
    h.close();
  }
});

test("an unknown session id returns without throwing", async () => {
  const h = harness();
  try {
    await runGuidedReview("missing", h.deps);

    assert.equal(h.git.calls.prepared.length, 0);
  } finally {
    h.close();
  }
});

test("a session store that stops accepting updates does not make the run throw", async () => {
  const h = harness();
  try {
    const sessions: ReviewSessionStore = {
      ...h.sessions,
      update() {
        throw new Error("database is closed");
      },
    };

    await runGuidedReview(h.sessionId, { ...h.deps, sessions });

    assert.equal(h.git.calls.prepared.length, 0);
  } finally {
    h.close();
  }
});

test("a session store that fails on read does not make the run throw", async () => {
  const h = harness();
  try {
    const sessions: ReviewSessionStore = {
      ...h.sessions,
      get() {
        throw new Error("database is locked");
      },
    };

    await runGuidedReview(h.sessionId, { ...h.deps, sessions });

    assert.equal(h.git.calls.prepared.length, 0);
  } finally {
    h.close();
  }
});

test("a run dir that cannot be removed does not escape or change the result", async () => {
  const runs = { dir: "" };
  const agent = fakeAgent("primary", {
    guide: json(GUIDE),
    review: () => {
      // Lock the parent once the run dir exists so its removal fails.
      chmodSync(runs.dir, 0o500);
      return JSON.stringify(PRIMARY);
    },
  });
  const h = harness({ agent });
  runs.dir = join(h.deps.config.stateDir, "runs");
  try {
    await runGuidedReview(h.sessionId, h.deps);

    assert.equal(h.sessions.get(h.sessionId)!.status, "ready");
    assert.equal(existsSync(h.runDir), true);
  } finally {
    chmodSync(runs.dir, 0o700);
    h.close();
  }
});

/** Counts how many runs of `inner` overlap. */
function overlapAgent(inner: FakeAgent) {
  let active = 0;
  let peak = 0;
  const agent: FakeAgent = {
    ...inner,
    async run(input) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 5));
      try {
        return await inner.run(input);
      } finally {
        active -= 1;
      }
    },
  };
  return { agent, peak: () => peak };
}

test("with one run slot the guide and the review take turns", async () => {
  for (const [maxConcurrentRuns, expected] of [
    [1, 1],
    [2, 2],
  ]) {
    const counted = overlapAgent(
      fakeAgent("primary", { guide: json(GUIDE), review: json(PRIMARY) }),
    );
    const h = harness({ agent: counted.agent, config: { maxConcurrentRuns } });
    try {
      await runGuidedReview(h.sessionId, h.deps);
      assert.equal(h.sessions.get(h.sessionId)!.status, "ready");
      assert.equal(counted.peak(), expected);
    } finally {
      h.close();
    }
  }
});

test("a run that the server stopped returns quietly and still cleans up", async () => {
  const h = harness();
  try {
    let updates = 0;
    const sessions: ReviewSessionStore = {
      ...h.sessions,
      update(id, patch) {
        if (patch.status === "analyzing") throw new ServerStoppedError();
        updates += 1;
        return h.sessions.update(id, patch);
      },
    };

    await runGuidedReview(h.sessionId, { ...h.deps, sessions });

    // No failure is recorded: the shutdown already marked the session.
    assert.notEqual(h.sessions.get(h.sessionId)!.status, "failed");
    assert.equal(updates, 4);
    assert.deepEqual(cleanedRoles(h.git), ["guide", "review"]);
  } finally {
    h.close();
  }
});
