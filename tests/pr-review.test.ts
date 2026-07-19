import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentAdapter,
  AgentRunInput,
  AgentRunResult,
} from "../src/agents/types.js";
import type { Config } from "../src/config.js";
import { GitHubRepoStateStore } from "../src/github/state.js";
import { buildReviewPrompt } from "../src/workflows/pr-review/context.js";
import {
  parseRightSidePatchLines,
  PullRequestReviewWorkflow,
} from "../src/workflows/pr-review/index.js";
import {
  findingFingerprint,
  parseReviewResult,
} from "../src/workflows/pr-review/parser.js";
import { decideAdversarialReview } from "../src/workflows/pr-review/risk.js";
import { parseReviewTarget } from "../src/workflows/pr-review/target.js";
import type {
  PullRequestReviewContext,
  ReviewResult,
} from "../src/workflows/pr-review/types.js";

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

function makeConfig(root: string): Config {
  return {
    githubToken: "test-token",
    repos: [],
    pollIntervalSec: 60,
    commentBatchWindowSec: 120,
    commentBatchMinComments: 2,
    commentBatchMaxWaitSec: 300,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 1800,
    agentMaxAttempts: 5,
    agent: "fake",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "fake",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    stateDir: join(root, "state"),
    zcodeBin: "zcode",
    claudeCodeBin: "claude",
    codexBin: "codex",
    keepWorkdirs: false,
  };
}

function makeContext(): PullRequestReviewContext {
  return {
    repo: { owner: "local-owner", repo: "sample-repo" },
    prNumber: 12,
    title: "Add feature",
    body: "PR body",
    headRef: "main",
    baseRef: "develop",
    files: [
      {
        path: "src/example.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+added",
      },
    ],
  };
}

class FakeAgent implements AgentAdapter {
  readonly name = "fake";

  constructor(
    private readonly result: ReviewResult,
    private readonly opts: { dirty?: boolean; exitCode?: number } = {},
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.opts.dirty) {
      writeFileSync(join(input.workdir, "agent-output.txt"), "dirty\n");
    }
    return {
      exitCode: this.opts.exitCode ?? 0,
      stdout: JSON.stringify(this.result),
      stderr: "",
    };
  }
}

class FakeReviewClient {
  readonly postedReviews: Array<{
    body: string;
    comments: Array<{ path: string; line: number; body: string }>;
  }> = [];

  async getPullRequest(): Promise<{
    number: number;
    title: string;
    body: string | null;
    headRef: string;
    baseRef: string;
    draft: boolean;
  }> {
    return {
      number: 1,
      title: "Test PR",
      body: "Test body",
      headRef: "main",
      baseRef: "main",
      draft: false,
    };
  }

  async listPullRequestFiles(): Promise<
    Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string | null;
    }>
  > {
    return [
      {
        path: "README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-# test\n+# test updated",
      },
    ];
  }

  async createPullRequestReview(args: {
    body: string;
    comments: Array<{ path: string; line: number; body: string }>;
  }): Promise<void> {
    this.postedReviews.push({ body: args.body, comments: args.comments });
  }
}

test("parseReviewTarget handles owner/repo slug and GitHub PR URL", () => {
  assert.deepEqual(parseReviewTarget("EK-LABS-LLC/trace-cli#11"), {
    repo: { owner: "EK-LABS-LLC", repo: "trace-cli" },
    prNumber: 11,
  });
  assert.deepEqual(
    parseReviewTarget("https://github.com/EK-LABS-LLC/pluto-predicts/pull/1"),
    {
      repo: { owner: "EK-LABS-LLC", repo: "pluto-predicts" },
      prNumber: 1,
    },
  );
  assert.throws(() => parseReviewTarget("not-a-pr"), /Invalid PR target/);
});

test("buildReviewPrompt includes read-only review contract and changed file context", () => {
  const prompt = buildReviewPrompt(makeContext());
  assert.match(prompt, /review-only engineer/);
  assert.match(prompt, /do not edit files, commit, push/);
  assert.match(prompt, /src\/example\.ts/);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /critical\|high\|medium\|low/);
  assert.match(prompt, /embedded \$pr-reviewer skill contract/);
});

test("auto adversarial review is gated by deterministic risk signals", () => {
  const lowRisk = decideAdversarialReview("auto", makeContext(), {
    summary: "No issues",
    findings: [],
  });
  assert.equal(lowRisk.run, false);
  assert.deepEqual(lowRisk.reasons, ["low-risk"]);

  const highRisk = decideAdversarialReview("auto", makeContext(), {
    summary: "One serious issue",
    findings: [
      {
        path: "src/example.ts",
        line: 2,
        body: "This bypasses authorization.",
        severity: "high",
      },
    ],
  });
  assert.equal(highRisk.run, true);
  assert.match(highRisk.reasons.join(","), /high-severity-primary-finding/);
});

test("adversarial prompt omits duplicated patches and marks primary output untrusted", () => {
  const prompt = buildReviewPrompt(makeContext(), {
    role: "adversarial",
    primaryReview: { summary: "Primary", findings: [] },
    includePatches: false,
  });
  assert.doesNotMatch(prompt, /@@ -1,2 \+1,3 @@/);
  assert.match(prompt, /Patch omitted to reduce prompt cost/);
  assert.match(prompt, /untrusted hypotheses/);
});

test("adversarial pass receives the primary result and becomes the final review", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-workflows-pr-review-adversarial-"),
  );
  try {
    const remote = createBareRemote(root);
    const primary: ReviewResult = {
      summary: "Primary",
      findings: [
        {
          path: "README.md",
          line: 1,
          body: "Primary finding.",
          severity: "medium",
        },
      ],
    };
    const adversarial: ReviewResult = {
      summary: "Adversarial verified review",
      findings: [
        {
          path: "README.md",
          line: 1,
          body: "Verified finding.",
          severity: "high",
        },
      ],
    };
    let adversarialPrompt = "";
    const adversarialAgent: AgentAdapter = {
      name: "adversarial-fake",
      async run(input): Promise<AgentRunResult> {
        adversarialPrompt = input.prompt;
        return { exitCode: 0, stdout: JSON.stringify(adversarial), stderr: "" };
      },
    };
    const client = new FakeReviewClient();
    const result = await new PullRequestReviewWorkflow().run({
      config: makeConfig(root),
      client,
      agent: new FakeAgent(primary),
      adversarialAgent,
      adversarialMode: "always",
      target: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        prNumber: 1,
      },
      post: true,
      cloneUrlOverride: remote,
    });

    assert.equal(result.adversarialRan, true);
    assert.equal(result.review.summary, adversarial.summary);
    assert.equal(client.postedReviews.length, 1);
    assert.match(adversarialPrompt, /Primary review JSON:/);
    assert.match(adversarialPrompt, /Primary finding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseReviewResult accepts valid JSON and rejects malformed findings", () => {
  const parsed = parseReviewResult(
    JSON.stringify({
      summary: "Found one issue",
      findings: [
        {
          path: "src/example.ts",
          line: 10,
          body: "This can throw on empty input.",
          severity: "high",
        },
      ],
    }),
  );
  assert.equal(parsed.findings.length, 1);
  assert.equal(
    findingFingerprint(parsed.findings[0]),
    "src/example.ts:10:high:this can throw on empty input.",
  );
  assert.throws(() => parseReviewResult("not json"), /not valid JSON/);
  assert.throws(
    () =>
      parseReviewResult(
        JSON.stringify({ summary: "bad", findings: [{ line: 0 }] }),
      ),
    /path must be a non-empty string/,
  );
});

test("dry-run review runs agent and does not post or persist duplicate state", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-pr-review-dry-"));
  try {
    const remote = createBareRemote(root);
    const client = new FakeReviewClient();
    const config = makeConfig(root);
    const workflow = new PullRequestReviewWorkflow();
    const result = await workflow.run({
      config,
      client,
      agent: new FakeAgent({
        summary: "One issue",
        findings: [
          {
            path: "README.md",
            line: 1,
            body: "Fix the heading.",
            severity: "medium",
          },
        ],
      }),
      target: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        prNumber: 1,
      },
      post: false,
      cloneUrlOverride: remote,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.newFindings.length, 1);
    assert.equal(client.postedReviews.length, 0);
    assert.equal(
      existsSync(
        join(config.stateDir, "github", "local-owner", "sample-repo.json"),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post mode submits one grouped review and skips duplicate findings later", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-pr-review-post-"));
  try {
    const remote = createBareRemote(root);
    const client = new FakeReviewClient();
    const config = makeConfig(root);
    const workflow = new PullRequestReviewWorkflow();
    const reviewResult: ReviewResult = {
      summary: "One issue",
      findings: [
        {
          path: "README.md",
          line: 1,
          body: "Fix the heading.",
          severity: "medium",
        },
      ],
    };
    const target = {
      repo: { owner: "local-owner", repo: "sample-repo" },
      prNumber: 1,
    };

    const first = await workflow.run({
      config,
      client,
      agent: new FakeAgent(reviewResult),
      target,
      post: true,
      cloneUrlOverride: remote,
    });
    const second = await workflow.run({
      config,
      client,
      agent: new FakeAgent(reviewResult),
      target,
      post: true,
      cloneUrlOverride: remote,
    });

    assert.equal(first.newFindings.length, 1);
    assert.equal(second.newFindings.length, 0);
    assert.equal(second.skippedDuplicateFindings, 1);
    assert.equal(client.postedReviews.length, 1);
    assert.match(client.postedReviews[0].body, /agent-workflows:bot/);
    assert.match(
      client.postedReviews[0].comments[0].body,
      /agent-workflows:bot/,
    );

    const state = GitHubRepoStateStore.fromConfig(config, target.repo);
    assert.equal(state.getPostedReviewFindingKeys(1).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post mode skips findings that cannot attach to the PR diff", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-workflows-pr-review-unpostable-"),
  );
  try {
    const remote = createBareRemote(root);
    const client = new FakeReviewClient();
    const config = makeConfig(root);
    const result = await new PullRequestReviewWorkflow().run({
      config,
      client,
      agent: new FakeAgent({
        summary: "One issue",
        findings: [
          {
            path: "README.md",
            line: 99,
            body: "This line is not in the PR diff.",
            severity: "medium",
          },
        ],
      }),
      target: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        prNumber: 1,
      },
      post: true,
      cloneUrlOverride: remote,
    });

    assert.equal(result.newFindings.length, 0);
    assert.equal(result.skippedUnpostableFindings, 1);
    assert.equal(client.postedReviews.length, 0);

    const state = GitHubRepoStateStore.fromConfig(config, {
      owner: "local-owner",
      repo: "sample-repo",
    });
    assert.equal(state.getPostedReviewFindingKeys(1).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post mode keeps valid diff findings while skipping invalid ones", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-workflows-pr-review-partial-"),
  );
  try {
    const remote = createBareRemote(root);
    const client = new FakeReviewClient();
    const result = await new PullRequestReviewWorkflow().run({
      config: makeConfig(root),
      client,
      agent: new FakeAgent({
        summary: "Two issues",
        findings: [
          {
            path: "README.md",
            line: 1,
            body: "Valid diff finding.",
            severity: "medium",
          },
          {
            path: "README.md",
            line: 99,
            body: "Invalid diff finding.",
            severity: "medium",
          },
          {
            path: "missing.ts",
            line: 1,
            body: "Missing file finding.",
            severity: "low",
          },
        ],
      }),
      target: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        prNumber: 1,
      },
      post: true,
      cloneUrlOverride: remote,
    });

    assert.equal(result.newFindings.length, 1);
    assert.equal(result.skippedUnpostableFindings, 2);
    assert.equal(client.postedReviews.length, 1);
    assert.equal(client.postedReviews[0].comments.length, 1);
    assert.equal(client.postedReviews[0].comments[0].line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty worktree review fails without posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-pr-review-dirty-"));
  try {
    const remote = createBareRemote(root);
    const client = new FakeReviewClient();
    const workflow = new PullRequestReviewWorkflow();
    await assert.rejects(
      () =>
        workflow.run({
          config: makeConfig(root),
          client,
          agent: new FakeAgent(
            { summary: "Dirty", findings: [] },
            { dirty: true },
          ),
          target: {
            repo: { owner: "local-owner", repo: "sample-repo" },
            prNumber: 1,
          },
          post: true,
          cloneUrlOverride: remote,
        }),
      /modified files during review-only mode/,
    );
    assert.equal(client.postedReviews.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft PR review fails before running agent or posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-pr-review-draft-"));
  try {
    const client = new (class extends FakeReviewClient {
      async getPullRequest(): Promise<{
        number: number;
        title: string;
        body: string | null;
        headRef: string;
        baseRef: string;
        draft: boolean;
      }> {
        return {
          number: 1,
          title: "Draft PR",
          body: null,
          headRef: "main",
          baseRef: "main",
          draft: true,
        };
      }
    })();
    let agentRan = false;
    const agent: AgentAdapter = {
      name: "fake",
      async run(): Promise<AgentRunResult> {
        agentRan = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ summary: "ok", findings: [] }),
          stderr: "",
        };
      },
    };

    await assert.rejects(
      () =>
        new PullRequestReviewWorkflow().run({
          config: makeConfig(root),
          client,
          agent,
          target: {
            repo: { owner: "local-owner", repo: "sample-repo" },
            prNumber: 1,
          },
          post: true,
        }),
      /is a draft/,
    );
    assert.equal(agentRan, false);
    assert.equal(client.postedReviews.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review parser rejects each malformed result field and normalizes valid strings", () => {
  const invalid: Array<[unknown, RegExp]> = [
    ["", /no output/],
    ["null", /JSON object/],
    ["[]", /JSON object/],
    ["1", /JSON object/],
    [JSON.stringify({ summary: 1, findings: [] }), /summary must be a string/],
    [
      JSON.stringify({ summary: "x", findings: {} }),
      /findings must be an array/,
    ],
    [JSON.stringify({ summary: "x", findings: [null] }), /must be an object/],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: 1, line: 1, body: "x", severity: "low" }],
      }),
      /path/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: " ", line: 1, body: "x", severity: "low" }],
      }),
      /path/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: "1", body: "x", severity: "low" }],
      }),
      /line/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 1.5, body: "x", severity: "low" }],
      }),
      /line/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 0, body: "x", severity: "low" }],
      }),
      /line/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 1, body: 1, severity: "low" }],
      }),
      /body/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 1, body: " ", severity: "low" }],
      }),
      /body/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 1, body: "x", severity: 1 }],
      }),
      /severity/,
    ],
    [
      JSON.stringify({
        summary: "x",
        findings: [{ path: "a", line: 1, body: "x", severity: "urgent" }],
      }),
      /severity/,
    ],
  ];
  for (const [value, expected] of invalid) {
    assert.throws(() => parseReviewResult(String(value)), expected);
  }
  assert.deepEqual(
    parseReviewResult(
      JSON.stringify({
        summary: "ok",
        findings: [
          { path: " a.ts ", line: 1, body: " fix me ", severity: "critical" },
        ],
      }),
    ).findings[0],
    { path: "a.ts", line: 1, body: "fix me", severity: "critical" },
  );
});

test("review prompt handles missing descriptions/patches and enforces adversarial inputs", () => {
  const context = makeContext();
  context.body = null;
  context.files[0].patch = null;
  const prompt = buildReviewPrompt(context);
  assert.doesNotMatch(prompt, /PR description/);
  assert.match(prompt, /Patch: unavailable/);
  assert.throws(
    () => buildReviewPrompt(context, { role: "adversarial" }),
    /requires the primary review/,
  );
});

test("risk policy covers explicit modes and all automatic risk signals", () => {
  assert.deepEqual(
    decideAdversarialReview("off", makeContext(), {
      summary: "",
      findings: [],
    }),
    { run: false, reasons: ["disabled"] },
  );
  assert.deepEqual(
    decideAdversarialReview("always", makeContext(), {
      summary: "",
      findings: [],
    }),
    { run: true, reasons: ["configured-always"] },
  );
  const context = makeContext();
  context.files = Array.from({ length: 12 }, (_, index) => ({
    path: index === 0 ? "security/auth.ts" : `src/file-${index}.ts`,
    status: "modified",
    additions: 40,
    deletions: 0,
    patch: index === 1 ? null : "patch",
  }));
  const decision = decideAdversarialReview("auto", context, {
    summary: "critical",
    findings: [
      {
        path: "security/auth.ts",
        line: 1,
        body: "critical",
        severity: "critical",
      },
    ],
  });
  assert.deepEqual(decision.reasons, [
    "many-files:12",
    "large-diff:480",
    "sensitive-path",
    "missing-patch",
    "high-severity-primary-finding",
  ]);
});

test("right-side patch parsing tracks context/additions and ignores metadata/deletions", () => {
  assert.deepEqual([...parseRightSidePatchLines(null)], []);
  assert.deepEqual(
    [
      ...parseRightSidePatchLines(
        [
          "metadata before hunk",
          "@@ -1,2 +10,4 @@ heading",
          " context",
          "-deleted",
          "+added",
          "\\ No newline at end of file",
          "unexpected metadata",
          "+after metadata",
        ].join("\n"),
      ),
    ],
    [10, 11, 13],
  );
});

test("review workflow reports missing adversarial adapters, agent failures, and malformed output", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-pr-review-errors-"));
  try {
    const remote = createBareRemote(root);
    const base = {
      config: makeConfig(root),
      client: new FakeReviewClient(),
      target: {
        repo: { owner: "local-owner", repo: "sample-repo" },
        prNumber: 1,
      },
      post: false,
      cloneUrlOverride: remote,
    };
    const missing = await new PullRequestReviewWorkflow().run({
      ...base,
      agent: new FakeAgent({ summary: "ok", findings: [] }),
      adversarialMode: "always",
    });
    assert.equal(missing.adversarialRan, false);
    assert.deepEqual(missing.adversarialReasons, ["configured-always"]);

    await assert.rejects(
      () =>
        new PullRequestReviewWorkflow().run({
          ...base,
          agent: new FakeAgent(
            { summary: "bad", findings: [] },
            { exitCode: 7 },
          ),
        }),
      /Primary review agent exited 7/,
    );

    const malformed: AgentAdapter = {
      name: "malformed",
      async run() {
        return { exitCode: 0, stdout: "not-json", stderr: "parse details" };
      },
    };
    await assert.rejects(
      () => new PullRequestReviewWorkflow().run({ ...base, agent: malformed }),
      /Failed to parse primary review agent output/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
