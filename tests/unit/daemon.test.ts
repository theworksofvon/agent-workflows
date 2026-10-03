import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../../src/config.js";
import type {
  Comment,
  CommentBatch,
  PullRequest,
} from "../../src/domain/events.js";
import { Daemon, type DaemonPorts } from "../../src/services/daemon.js";
import { Dispatcher } from "../../src/services/dispatch.js";

function makeConfig(): Config {
  return {
    githubToken: "test-token",
    repos: [{ owner: "owner", repo: "repo" }],
    pollIntervalSec: 5,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 1,
    commentBatchMaxWaitSec: 0,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 0,
    agentMaxAttempts: 5,
    agent: "codex",
    reviewAdversarialMode: "auto",
    reviewAdversarialAgent: "claude-code",
    processExistingCommentsOnFirstRun: false,
    agentSelfUser: null,
    allowedAuthors: null,
    stateDir: "/tmp/daemon-test-state",
    zcodeBin: "zcode-test",
    claudeCodeBin: "claude-test",
    codexBin: "codex-test",
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

const pr: PullRequest = {
  repo: { owner: "owner", repo: "repo" },
  number: 7,
  title: "t",
  body: null,
  headRef: "head",
  baseRef: "main",
  draft: false,
  fromFork: false,
};

const comment: Comment = {
  key: "k",
  id: 1,
  kind: "issue",
  author: "a",
  body: "b",
  createdAt: "",
};

const batch = { batchId: "b1", repo: pr.repo, prNumber: 7 } as CommentBatch;

function ports(overrides: Partial<DaemonPorts> = {}): DaemonPorts {
  return {
    config: makeConfig(),
    poll: async () => [],
    handleBatch: async () => {},
    ...overrides,
  };
}

test("tick dispatches polled batches, reports poll errors, and skips overlap", async () => {
  const handled: string[] = [];
  const daemon = new Daemon(
    ports({
      poll: async () => [
        { batchId: "1", repo: pr.repo, prNumber: 1 } as CommentBatch,
        { batchId: "3", repo: pr.repo, prNumber: 2 } as CommentBatch,
      ],
      handleBatch: async (b) => {
        handled.push(b.batchId);
      },
    }),
  );
  await daemon.tick();
  await daemon.idle();
  assert.deepEqual(handled.sort(), ["1", "3"]);

  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let polls = 0;
  const overlapping = new Daemon(
    ports({
      poll: async () => {
        polls += 1;
        await gate;
        return [];
      },
    }),
  );
  const first = overlapping.tick();
  await overlapping.tick();
  release();
  await first;
  assert.equal(polls, 1);

  const failing = new Daemon(
    ports({
      poll: async () => {
        throw new Error("poll broke");
      },
    }),
  );
  await failing.tick();
});

test("batches for one PR run serially while other PRs run in parallel", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const daemon = new Daemon(
    ports({
      poll: async () => [
        { batchId: "a1", repo: pr.repo, prNumber: 1 } as CommentBatch,
        { batchId: "a2", repo: pr.repo, prNumber: 1 } as CommentBatch,
        { batchId: "b1", repo: pr.repo, prNumber: 2 } as CommentBatch,
      ],
      handleBatch: async (b) => {
        order.push(`${b.batchId}-start`);
        if (b.batchId === "a1") await gate;
      },
    }),
  );
  await daemon.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["a1-start", "b1-start"]);
  release();
  await daemon.idle();
  assert.deepEqual(order, ["a1-start", "b1-start", "a2-start"]);
});

test("Daemon start/stop owns one deterministic recursive timer", async () => {
  const timers: Array<{ callback: () => void; delay: number; handle: object }> =
    [];
  const cleared: object[] = [];
  let polls = 0;
  const daemon = new Daemon(
    ports({
      poll: async () => {
        polls += 1;
        return [];
      },
      setTimeout: ((callback: () => void, delay: number) => {
        const handle = setTimeout(() => {}, 60_000);
        handle.unref();
        const timer = { callback: () => callback(), delay, handle };
        timers.push(timer);
        return timer.handle;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
        cleared.push(handle);
        clearTimeout(handle);
      }) as typeof clearTimeout,
    }),
  );
  await daemon.start();
  await daemon.start();
  assert.equal(polls, 1);
  assert.equal(timers[0].delay, 5000);
  timers[0].callback();
  await new Promise((done) => setImmediate(done));
  assert.equal(polls, 2);
  assert.equal(timers.length, 2);
  daemon.stop();
  assert.deepEqual(cleared, [timers[1].handle]);
  daemon.stop();

  const stopDuringPoll: Daemon = new Daemon(
    ports({
      poll: async () => {
        stopDuringPoll.stop();
        return [];
      },
      setTimeout: (() => {
        throw new Error("must not schedule");
      }) as unknown as typeof setTimeout,
    }),
  );
  await stopDuringPoll.start();
});

test("Daemon restart while the first start is polling keeps one timer chain", async () => {
  const timers: Array<{
    callback: () => void;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  let polls = 0;
  let releaseFirstPoll!: () => void;
  const firstPollGate = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });
  const daemon = new Daemon(
    ports({
      poll: async () => {
        polls += 1;
        if (polls === 1) await firstPollGate;
        return [];
      },
      setTimeout: ((callback: () => void) => {
        const handle = setTimeout(() => {}, 60_000);
        handle.unref();
        timers.push({ callback: () => callback(), handle });
        return handle;
      }) as unknown as typeof setTimeout,
    }),
  );

  const firstStart = daemon.start();
  await new Promise((resolve) => setImmediate(resolve));
  daemon.stop();
  await daemon.start();
  assert.equal(timers.length, 1);

  releaseFirstPoll();
  await firstStart;
  assert.equal(timers.length, 1);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2);
  assert.equal(timers.length, 2);
  daemon.stop();
});

test("dispatchEvents routes ready batches and auto-review events onto PR lanes", async () => {
  const handled: string[] = [];
  const reviewed: number[] = [];
  const daemon = new Daemon({
    config: { ...makeConfig(), autoReview: true },
    poll: async () => [],
    handleBatch: async (b) => {
      handled.push(b.batchId);
    },
    reviewPullRequest: async (t) => {
      reviewed.push(t.prNumber);
    },
    dispatcher: new Dispatcher(2),
  });
  daemon.dispatchEvents(
    [
      { kind: "pull_request_ready", pr },
      { kind: "comment", pr, comment },
    ],
    [batch],
  );
  await daemon.idle();
  assert.deepEqual(handled, [batch.batchId]);
  assert.deepEqual(reviewed, [pr.number]);
});

test("auto-review is ignored when disabled or unwired, and comment events are not dispatched", async () => {
  const handled: string[] = [];
  const reviewed: number[] = [];
  const disabled = new Daemon({
    config: { ...makeConfig(), autoReview: false },
    poll: async () => [],
    handleBatch: async (b) => {
      handled.push(b.batchId);
    },
    reviewPullRequest: async (t) => {
      reviewed.push(t.prNumber);
    },
  });
  disabled.dispatchEvents(
    [
      { kind: "pull_request_ready", pr },
      {
        kind: "comment",
        pr,
        comment: {
          key: "k",
          id: 1,
          kind: "issue",
          author: "a",
          body: "b",
          createdAt: "",
        },
      },
    ],
    [batch],
  );
  await disabled.idle();
  assert.deepEqual(handled, [batch.batchId]);
  assert.deepEqual(reviewed, []);

  const unwired = new Daemon({
    config: { ...makeConfig(), autoReview: true },
    poll: async () => [],
    handleBatch: async () => {},
  });
  unwired.dispatchEvents([{ kind: "pull_request_ready", pr }], []);
  await unwired.idle();
});

test("same PR number in different repos uses different lanes", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const daemon = new Daemon(
    ports({
      dispatcher: new Dispatcher(2),
      handleBatch: async (b) => {
        started.push(b.batchId);
        await gate;
      },
    }),
  );
  daemon.dispatchEvents([], [
    { batchId: "x", repo: { owner: "o", repo: "one" }, prNumber: 5 },
    { batchId: "y", repo: { owner: "o", repo: "two" }, prNumber: 5 },
  ] as CommentBatch[]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["x", "y"]);
  release();
  await daemon.idle();
});
