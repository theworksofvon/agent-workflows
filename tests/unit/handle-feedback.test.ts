import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import type {
  AgentAdapter,
  AgentRunInput,
} from "../../src/adapters/agent/agent.interface.js";
import type {
  GitPort,
  WorkdirHandle,
} from "../../src/adapters/git/git.interface.js";
import { GitHubRepoStateStore } from "../../src/adapters/state/json-file.js";
import type { CommentBatch } from "../../src/domain/events.js";
import { MARKER_TAG } from "../../src/domain/batching.js";
import { PushRejectedError } from "../../src/domain/errors.js";
import {
  buildLaunchPrompt,
  buildPacket,
  handleFeedback,
} from "../../src/services/handle-feedback.js";

function config(root: string): Config {
  return {
    githubToken: "t",
    repos: [],
    pollIntervalSec: 300,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 2,
    agentMaxAttempts: 3,
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    allowedAuthors: null,
    stateDir: join(root, "state"),
    zcodeBin: "z",
    claudeCodeBin: "c",
    codexBin: "x",
    keepWorkdirs: false,
    host: "127.0.0.1",
    port: 3773,
    webhookSecret: null,
    publicUrl: null,
    tailscaleFunnel: false,
    maxConcurrentRuns: 3,
    autoReview: false,
  };
}

function batch(): CommentBatch {
  return {
    repo: { owner: "o", repo: "r" },
    prNumber: 4,
    prTitle: "T",
    prBody: null,
    headRef: "f",
    baseRef: "main",
    batchId: "batch:o/r:pr:4:conversation:1",
    groupKey: "pr:4:conversation",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:01Z",
    attempts: 1,
    comments: [
      {
        key: "o/r#4:issue:1",
        id: 1,
        kind: "issue",
        author: "alice",
        body: "fix a",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        key: "o/r#4:review:2",
        id: 2,
        kind: "review",
        author: "bob",
        body: "fix b",
        createdAt: "2026-01-01T00:00:01Z",
        reviewId: 9,
        review: { path: "a.ts", line: 3, diffHunk: "@@" },
      },
    ],
  };
}

interface Calls {
  pushes: number;
  pushLeases: string[];
  comments: string[];
  replies: Array<{ id: number; body: string }>;
  cleanups: number;
}

function newCalls(): Calls {
  return { pushes: 0, pushLeases: [], comments: [], replies: [], cleanups: 0 };
}

function fakeGit(
  root: string,
  opts: { ahead?: number; pushError?: Error } = {},
  calls: Calls,
): GitPort {
  const handle: WorkdirHandle = {
    path: join(root, "wt"),
    branch: "f",
    localBranch: "l",
    baseSha: "abc",
    repoCachePath: root,
  };
  mkdirSync(handle.path, { recursive: true });
  return {
    prepareWorkdir: () => handle,
    cleanupWorkdir: () => {
      calls.cleanups += 1;
    },
    hasUncommittedChanges: () => false,
    commitUncommittedChanges: () => false,
    commitsAhead: () => opts.ahead ?? 0,
    pushBranch: (_workdir, _branch, expectedRemoteSha) => {
      calls.pushLeases.push(expectedRemoteSha);
      if (opts.pushError) throw opts.pushError;
      calls.pushes += 1;
    },
  };
}

function reportWritingAgent(
  report: unknown | null,
  opts: { exitCode?: number; stderr?: string; writeOnSecondRun?: boolean } = {},
): AgentAdapter & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    prompts,
    async run(input: AgentRunInput) {
      prompts.push(input.prompt);
      const reportPath =
        /write your report to (\S+)\./i.exec(input.prompt)?.[1] ??
        /report at (\S+) is missing/.exec(input.prompt)?.[1];
      const shouldWrite =
        report !== null && (!opts.writeOnSecondRun || prompts.length === 2);
      if (shouldWrite && reportPath)
        writeFileSync(
          reportPath,
          typeof report === "string" ? report : JSON.stringify(report),
        );
      return {
        exitCode: opts.exitCode ?? 0,
        stdout: "",
        stderr: opts.stderr ?? "",
      };
    },
  };
}

function ports(root: string, agent: AgentAdapter, git: GitPort, calls: Calls) {
  const cfg = config(root);
  return {
    config: cfg,
    agent,
    git,
    state: (repo: { owner: string; repo: string }) =>
      GitHubRepoStateStore.fromConfig(cfg, repo),
    github: {
      async createComment(_r: unknown, _n: number, body: string) {
        calls.comments.push(body);
      },
      async replyToReviewComment(
        _r: unknown,
        _n: number,
        id: number,
        body: string,
      ) {
        calls.replies.push({ id, body });
      },
    },
  };
}

const fullReport = {
  summary: "Fixed a, skipped b",
  comments: [
    { key: "o/r#4:issue:1", decision: "addressed" },
    {
      key: "o/r#4:review:2",
      decision: "skipped",
      reason: "already done in abc123",
    },
  ],
};

test("packet and prompt carry absolute paths and every comment", () => {
  const packet = buildPacket(
    batch(),
    [
      {
        batchId: "x",
        handledAt: "h",
        agent: "a",
        exitCode: 0,
        commitCount: 1,
        commentKeys: [],
        summary: "s",
      },
    ],
    "/tmp/r.json",
  );
  assert.equal(packet.comments.length, 2);
  assert.equal(packet.comments[1].path, "a.ts");
  assert.deepEqual(packet.history, [{ handledAt: "h", summary: "s" }]);
  assert.equal(packet.reportPath, "/tmp/r.json");
  const prompt = buildLaunchPrompt("/tmp/p.json", "/tmp/r.json");
  assert.match(prompt, /Read the event packet at \/tmp\/p\.json\./);
  assert.match(
    prompt,
    /write your report to \/tmp\/r\.json\. This report is mandatory\./,
  );
  assert.match(prompt, /Do not push/);
});

test("valid report with commits pushes, replies on skipped review threads, and summarizes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(fullReport);
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 2 }, calls), calls),
    );
    assert.equal(outcome.kind, "pushed");
    assert.equal(calls.pushes, 1);
    assert.deepEqual(calls.pushLeases, ["abc"]);
    assert.deepEqual(
      calls.replies.map((r) => r.id),
      [2],
    );
    assert.match(
      calls.replies[0].body,
      new RegExp(`^${MARKER_TAG} \\*\\*Skipped:\\*\\* already done in abc123`),
    );
    assert.equal(calls.comments.length, 1);
    assert.match(
      calls.comments[0],
      /2 commit\(s\) pushed\. Addressed 1, skipped 1, needs a human 0\./,
    );
    assert.equal(calls.cleanups, 1);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(state.hasProcessedComment("o/r#4:issue:1"), true);
    assert.equal(existsSync(join(root, "state", "runs")), true);
    assert.equal(
      existsSync(join(root, "state", "runs", "batch_o_r_pr_4_conversation_1")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("needs_human on an issue comment lands in the summary, not a reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const report = {
      summary: "s",
      comments: [
        {
          key: "o/r#4:issue:1",
          decision: "needs_human",
          reason: "design conflict",
        },
        { key: "o/r#4:review:2", decision: "addressed" },
      ],
    };
    const outcome = await handleFeedback(
      batch(),
      ports(root, reportWritingAgent(report), fakeGit(root, {}, calls), calls),
    );
    assert.equal(outcome.kind, "no-changes");
    assert.equal(calls.pushes, 0);
    assert.equal(calls.replies.length, 0);
    assert.match(
      calls.comments[0],
      /Not addressed:\n- @alice: Needs a human: design conflict/,
    );
    assert.match(calls.comments[0], /0 commit\(s\) pushed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing report triggers one relaunch and succeeds when the second run writes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(fullReport, { writeOnSecondRun: true });
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 1 }, calls), calls),
    );
    assert.equal(outcome.kind, "pushed");
    assert.equal(agent.prompts.length, 2);
    assert.match(agent.prompts[1], /is missing\. Write it now/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no report after relaunch posts a summary, pushes nothing, marks processed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(null);
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 1 }, calls), calls),
    );
    assert.equal(outcome.kind, "no-report");
    assert.equal(agent.prompts.length, 2);
    assert.equal(calls.pushes, 0);
    assert.match(calls.comments[0], /no usable report .* batch not applied/);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(state.hasProcessedComment("o/r#4:review:2"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid report is treated as no report", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const outcome = await handleFeedback(
      batch(),
      ports(
        root,
        reportWritingAgent("not json"),
        fakeGit(root, { ahead: 1 }, calls),
        calls,
      ),
    );
    assert.equal(outcome.kind, "no-report");
    assert.equal(calls.pushes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rate-limited exit pauses the batch for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(null, {
      exitCode: 1,
      stderr: "429 rate limit",
    });
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, {}, calls), calls),
    );
    assert.equal(outcome.kind, "retry-scheduled");
    assert.equal(agent.prompts.length, 1);
    assert.equal(calls.comments.length, 0);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(
      state.takeReadyCommentBatches(Date.now() + 10_000, {
        quietWindowMs: 0,
        minComments: 1,
        maxWaitMs: 0,
      }).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rate-limited exit at max attempts falls through to the normal path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(fullReport, {
      exitCode: 1,
      stderr: "quota",
    });
    const outcome = await handleFeedback(
      { ...batch(), attempts: 3 },
      ports(root, agent, fakeGit(root, {}, calls), calls),
    );
    assert.equal(outcome.kind, "no-changes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejected lease discards and explains", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const outcome = await handleFeedback(
      batch(),
      ports(
        root,
        reportWritingAgent(fullReport),
        fakeGit(
          root,
          { ahead: 1, pushError: new PushRejectedError("f") },
          calls,
        ),
        calls,
      ),
    );
    assert.equal(outcome.kind, "lease-rejected");
    assert.match(
      calls.comments[0],
      /Branch moved during the run; 1 commit\(s\) discarded/,
    );
    assert.equal(calls.replies.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keepWorkdirs preserves the run directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const p = ports(
      root,
      reportWritingAgent(fullReport),
      fakeGit(root, {}, calls),
      calls,
    );
    p.config.keepWorkdirs = true;
    await handleFeedback(batch(), p);
    const runDir = join(root, "state", "runs", "batch_o_r_pr_4_conversation_1");
    assert.equal(existsSync(join(runDir, "packet.json")), true);
    assert.equal(
      JSON.parse(readFileSync(join(runDir, "packet.json"), "utf8")).prNumber,
      4,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packet carries the PR body, history, and only inline fields for review comments", () => {
  const packet = buildPacket(
    {
      ...batch(),
      prBody: "Description",
      comments: [
        batch().comments[0],
        {
          ...batch().comments[1],
          review: { path: "b.ts", line: null, diffHunk: "@@ -1 +1 @@" },
        },
      ],
    },
    [],
    "/tmp/r.json",
  );
  assert.equal(packet.repo, "o/r");
  assert.equal(packet.body, "Description");
  assert.deepEqual(packet.history, []);
  assert.equal("path" in packet.comments[0], false);
  assert.deepEqual(packet.comments[1], {
    key: "o/r#4:review:2",
    author: "bob",
    kind: "review",
    path: "b.ts",
    line: null,
    diffHunk: "@@ -1 +1 @@",
    body: "fix b",
    createdAt: "2026-01-01T00:00:01Z",
  });
});

test("retry delay comes from the injected clock and keeps the agent's error tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent: AgentAdapter = {
      name: "fake",
      async run() {
        return { exitCode: 9, stdout: "capacity unavailable", stderr: "" };
      },
    };
    const outcome = await handleFeedback(batch(), {
      ...ports(root, agent, fakeGit(root, {}, calls), calls),
      now: () => 10_000,
    });
    assert.deepEqual(outcome, {
      kind: "retry-scheduled",
      retryAfterMs: 12_000,
    });
    assert.equal(calls.cleanups, 1);
    const saved = JSON.parse(
      readFileSync(join(root, "state", "github", "o", "r.json"), "utf8"),
    );
    const group = saved.pendingCommentGroups["pr:4:conversation"];
    assert.equal(group.retryAfterMs, 12_000);
    assert.equal(group.lastError, "capacity unavailable");
    assert.equal(
      existsSync(join(root, "state", "runs", "batch_o_r_pr_4_conversation_1")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history records zero commits when no report or a rejected lease leaves nothing pushed", async () => {
  for (const scenario of ["no-report", "lease-rejected"] as const) {
    const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
    const calls: Calls = newCalls();
    try {
      const agent = reportWritingAgent(
        scenario === "no-report" ? null : fullReport,
      );
      const git = fakeGit(
        root,
        {
          ahead: 2,
          ...(scenario === "lease-rejected"
            ? { pushError: new PushRejectedError("f") }
            : {}),
        },
        calls,
      );
      const outcome = await handleFeedback(
        batch(),
        ports(root, agent, git, calls),
      );
      assert.equal(outcome.kind, scenario);
      const state = GitHubRepoStateStore.fromConfig(config(root), {
        owner: "o",
        repo: "r",
      });
      const [entry] = state.getRecentPrHistory(4, 5);
      assert.equal(entry.commitCount, 0);
      assert.equal(
        entry.summary,
        scenario === "no-report" ? "no report" : fullReport.summary,
      );
      assert.equal(state.hasProcessedComment("o/r#4:issue:1"), true);
      assert.equal(calls.cleanups, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("non-retryable failure without a report is not retried and posts the no-report summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const agent = reportWritingAgent(null, {
      exitCode: 2,
      stderr: "ordinary failure",
    });
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 1 }, calls), calls),
    );
    assert.equal(outcome.kind, "no-report");
    assert.equal(agent.prompts.length, 2);
    assert.equal(calls.pushes, 0);
    assert.equal(
      calls.comments[0],
      `${MARKER_TAG} Agent produced no usable report for @alice, @bob's 2 comments; batch not applied.`,
    );
    await handleFeedback(
      { ...batch(), comments: [batch().comments[0]] },
      ports(root, agent, fakeGit(root, {}, calls), calls),
    );
    assert.match(
      calls.comments[1],
      /for @alice's 1 comment; batch not applied/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report left by an earlier kept run is not mistaken for this run's report", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls: Calls = newCalls();
  try {
    const runDir = join(root, "state", "runs", "batch_o_r_pr_4_conversation_1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), JSON.stringify(fullReport));
    const agent = reportWritingAgent(null);
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 1 }, calls), calls),
    );
    assert.equal(outcome.kind, "no-report");
    assert.equal(calls.pushes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-lease push failure is retried while attempts remain", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const outcome = await handleFeedback(batch(), {
      ...ports(
        root,
        reportWritingAgent(fullReport),
        fakeGit(root, { ahead: 1, pushError: new Error("network") }, calls),
        calls,
      ),
      now: () => 10_000,
    });
    assert.deepEqual(outcome, {
      kind: "retry-scheduled",
      retryAfterMs: 12_000,
    });
    assert.equal(calls.comments.length, 0);
    assert.equal(calls.replies.length, 0);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(state.hasProcessedComment("o/r#4:issue:1"), false);
    assert.deepEqual(state.getRecentPrHistory(4, 5), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-lease push failure at max attempts posts push-failed and marks processed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const outcome = await handleFeedback(
      { ...batch(), attempts: 3 },
      ports(
        root,
        reportWritingAgent(fullReport),
        fakeGit(root, { ahead: 1, pushError: new Error("network") }, calls),
        calls,
      ),
    );
    assert.equal(outcome.kind, "push-failed");
    assert.equal(
      calls.comments[0],
      `${MARKER_TAG} Push failed after 3 attempts; 1 commit(s) discarded. ${fullReport.summary}`,
    );
    assert.equal(calls.replies.length, 0);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(state.hasProcessedComment("o/r#4:review:2"), true);
    assert.equal(state.getRecentPrHistory(4, 5)[0].commitCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub failures after a push are logged; state already records the push", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const p = ports(
      root,
      reportWritingAgent(fullReport),
      fakeGit(root, { ahead: 2 }, calls),
      calls,
    );
    p.github = {
      async createComment() {
        throw new Error("github down");
      },
      async replyToReviewComment() {
        throw new Error("github down");
      },
    };
    const outcome = await handleFeedback(batch(), p);
    assert.equal(outcome.kind, "pushed");
    assert.equal(calls.pushes, 1);
    const state = GitHubRepoStateStore.fromConfig(config(root), {
      owner: "o",
      repo: "r",
    });
    assert.equal(state.hasProcessedComment("o/r#4:issue:1"), true);
    assert.equal(state.getRecentPrHistory(4, 5)[0].commitCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thrown error pauses the batch for retry and still removes the run directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const git = fakeGit(root, {}, calls);
    git.prepareWorkdir = () => {
      throw new Error("clone failed");
    };
    const p = ports(root, reportWritingAgent(fullReport), git, calls);
    const outcome = await handleFeedback(batch(), p);
    assert.equal(outcome.kind, "retry-scheduled");
    assert.equal(calls.cleanups, 0);
    assert.deepEqual(calls.comments, []);
    assert.equal(
      existsSync(join(root, "state", "runs", "batch_o_r_pr_4_conversation_1")),
      false,
    );
    const state = p.state(batch().repo);
    assert.equal(state.hasProcessedComment("o/r#4:issue:1"), false);
    const [again] = state.takeReadyCommentBatches(Date.now() + 10_000, {
      quietWindowMs: 0,
      minComments: 1,
      maxWaitMs: 0,
    });
    assert.equal(again.comments.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thrown error at max attempts posts a failure summary and marks the batch processed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const git = fakeGit(root, {}, calls);
    git.prepareWorkdir = () => {
      throw new Error("clone failed");
    };
    const p = ports(root, reportWritingAgent(fullReport), git, calls);
    const outcome = await handleFeedback({ ...batch(), attempts: 3 }, p);
    assert.deepEqual(outcome, { kind: "failed", error: "clone failed" });
    assert.equal(calls.pushes, 0);
    assert.equal(calls.comments.length, 1);
    assert.match(calls.comments[0], /Run failed after 3 attempts/);
    assert.match(calls.comments[0], /clone failed/);
    const state = p.state(batch().repo);
    assert.equal(state.hasProcessedComment("o/r#4:issue:1"), true);
    assert.equal(state.getRecentPrHistory(4, 5)[0].exitCode, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rate-limited relaunch pauses the batch for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const prompts: string[] = [];
    const agent: AgentAdapter = {
      name: "fake",
      async run(input) {
        prompts.push(input.prompt);
        return prompts.length === 1
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "usage limit reached" };
      },
    };
    const outcome = await handleFeedback(
      batch(),
      ports(root, agent, fakeGit(root, { ahead: 1 }, calls), calls),
    );
    assert.equal(outcome.kind, "retry-scheduled");
    assert.equal(prompts.length, 2);
    assert.equal(calls.comments.length, 0);
    assert.equal(calls.pushes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("needs_human on a review comment replies on its thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-hf-"));
  const calls = newCalls();
  try {
    const report = {
      summary: "s",
      comments: [
        { key: "o/r#4:issue:1", decision: "addressed" },
        {
          key: "o/r#4:review:2",
          decision: "needs_human",
          reason: "conflicts with the design",
        },
      ],
    };
    await handleFeedback(
      batch(),
      ports(root, reportWritingAgent(report), fakeGit(root, {}, calls), calls),
    );
    assert.deepEqual(calls.replies, [
      {
        id: 2,
        body: `${MARKER_TAG} **Needs a human:** conflicts with the design`,
      },
    ]);
    assert.doesNotMatch(calls.comments[0], /Not addressed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
