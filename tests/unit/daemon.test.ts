import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../../src/config.js";
import type {
  Comment,
  CommentBatch,
  PullRequest,
} from "../../src/domain/events.js";
import {
  Daemon,
  SHUTDOWN_GRACE_MS,
  type DaemonPorts,
} from "../../src/services/daemon.js";
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

type Listener = NonNullable<DaemonPorts["startListener"]>;

function fakeListener(): {
  startListener: Listener;
  starts: Array<{ host: string; port: number }>;
  closes: number[];
  deliver: Parameters<Listener>[0]["onDelivery"];
} {
  const starts: Array<{ host: string; port: number }> = [];
  const closes: number[] = [];
  const state = {} as { onDelivery: Parameters<Listener>[0]["onDelivery"] };
  return {
    starts,
    closes,
    deliver: (d) => state.onDelivery(d),
    startListener: async ({ host, port, onDelivery }) => {
      starts.push({ host, port });
      state.onDelivery = onDelivery;
      return {
        url: `http://${host}:${port}`,
        close: async () => {
          closes.push(starts.length);
        },
      };
    },
  };
}

async function captureInfo(run: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

test("stop waits for a running batch to finish, then disarms the grace timer", async () => {
  let release: () => void = () => {};
  const finished: string[] = [];
  const armed: object[] = [];
  const cleared: object[] = [];
  const daemon = new Daemon(
    ports({
      poll: async () => [batch],
      handleBatch: async (b) => {
        await new Promise<void>((resolve) => (release = resolve));
        finished.push(b.batchId);
      },
      setTimeout: ((_callback: () => void, delay: number) => {
        const handle = { delay };
        armed.push(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((handle: object) => {
        cleared.push(handle);
      }) as unknown as typeof clearTimeout,
    }),
  );
  await daemon.start();
  let stopped = false;
  const stopping = daemon.stop().then(() => {
    stopped = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.deepEqual(finished, [batch.batchId]);
  // Both the poll timer and the grace timer were cleared.
  assert.deepEqual(cleared, armed);
  assert.equal(armed.length, 2);
});

test("stop gives up after the shutdown grace and leaves the batch to restart", async () => {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const daemon = new Daemon(
    ports({
      poll: async () => [batch],
      handleBatch: () => new Promise(() => {}),
      setTimeout: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    }),
  );
  await daemon.start();
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => {
    lines.push(line);
  };
  try {
    const stopping = daemon.stop();
    await new Promise((done) => setImmediate(done));
    const grace = timers.find((t) => t.delay === SHUTDOWN_GRACE_MS);
    assert.ok(grace, "a grace timer is armed while a batch is running");
    grace.callback();
    await stopping;
  } finally {
    console.warn = original;
  }
  assert.ok(lines.some((l) => l.includes("shutdown grace elapsed")));
});

test("start opens the webhook listener, logs its URL, and stop closes it", async () => {
  const listener = fakeListener();
  const daemon = new Daemon(
    ports({
      listener: { host: "127.0.0.1", port: 4000 },
      receiveDelivery: async () => ({
        status: 202,
        reason: "accepted",
        events: [],
        ready: [],
      }),
      startListener: listener.startListener,
    }),
  );
  const lines = await captureInfo(() => daemon.start());
  assert.deepEqual(listener.starts, [{ host: "127.0.0.1", port: 4000 }]);
  assert.ok(
    lines.some(
      (line) =>
        line.includes("webhook listener started") &&
        line.includes("http://127.0.0.1:4000"),
    ),
  );
  await daemon.stop();
  assert.deepEqual(listener.closes, [1]);
  await daemon.stop();
  assert.deepEqual(listener.closes, [1]);
});

test("a delivery's events and ready batches are dispatched and its result returned", async () => {
  const listener = fakeListener();
  const handled: string[] = [];
  const reviewed: number[] = [];
  const daemon = new Daemon(
    ports({
      config: { ...makeConfig(), autoReview: true },
      handleBatch: async (b) => {
        handled.push(b.batchId);
      },
      reviewPullRequest: async (t) => {
        reviewed.push(t.prNumber);
      },
      listener: { host: "127.0.0.1", port: 0 },
      receiveDelivery: async (d) => ({
        status: 202,
        reason: `accepted ${d.id}`,
        events: [{ kind: "pull_request_ready", pr }],
        ready: [batch],
      }),
      startListener: listener.startListener,
    }),
  );
  await daemon.start();
  const result = await listener.deliver({
    id: "d1",
    event: "pull_request",
    signature256: null,
    body: "{}",
  });
  assert.equal(result.status, 202);
  assert.equal(result.reason, "accepted d1");
  await daemon.idle();
  assert.deepEqual(handled, [batch.batchId]);
  assert.deepEqual(reviewed, [pr.number]);
  await daemon.stop();
});

test("start without all listener ports opens no listener", async () => {
  const listener = fakeListener();
  for (const partial of [
    { startListener: listener.startListener },
    {
      startListener: listener.startListener,
      listener: { host: "h", port: 1 },
    },
    {
      listener: { host: "h", port: 1 },
      receiveDelivery: async () => ({
        status: 202,
        reason: "accepted",
        events: [],
        ready: [],
      }),
    },
  ]) {
    const daemon = new Daemon(ports(partial));
    await daemon.start();
    await daemon.stop();
  }
  assert.deepEqual(listener.starts, []);
});

test("a stop during listener startup closes the listener once it opens", async () => {
  const listener = fakeListener();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let polls = 0;
  const daemon = new Daemon(
    ports({
      poll: async () => {
        polls += 1;
        return [];
      },
      listener: { host: "h", port: 1 },
      receiveDelivery: async () => ({
        status: 202,
        reason: "accepted",
        events: [],
        ready: [],
      }),
      startListener: async (args) => {
        await gate;
        return listener.startListener(args);
      },
    }),
  );
  const starting = daemon.start();
  await daemon.stop();
  release();
  await starting;
  assert.deepEqual(listener.closes, [1]);
  assert.equal(polls, 0);
});

test("a listener that fails to start fails start and leaves the daemon stopped", async () => {
  let polls = 0;
  const daemon = new Daemon(
    ports({
      poll: async () => {
        polls += 1;
        return [];
      },
      listener: { host: "h", port: 1 },
      receiveDelivery: async () => ({
        status: 202,
        reason: "accepted",
        events: [],
        ready: [],
      }),
      startListener: async () => {
        throw new Error("EADDRINUSE");
      },
    }),
  );
  await assert.rejects(daemon.start(), /EADDRINUSE/);
  assert.equal(polls, 0);
  await assert.rejects(daemon.start(), /EADDRINUSE/);
});
