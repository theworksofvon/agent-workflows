import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../../src/services/dispatch.js";

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { opened, release };
}

test("same lane runs serially, different lanes run in parallel", async () => {
  const d = new Dispatcher(3);
  const order: string[] = [];
  const g1 = gate();
  d.enqueue("a", async () => {
    order.push("a1-start");
    await g1.opened;
    order.push("a1-end");
  });
  d.enqueue("a", async () => {
    order.push("a2");
  });
  d.enqueue("b", async () => {
    order.push("b1");
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["a1-start", "b1"]);
  assert.equal(d.running, 1);
  g1.release();
  await d.idle();
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"]);
});

test("global cap limits concurrent lanes", async () => {
  const d = new Dispatcher(2);
  const gates = [gate(), gate(), gate()];
  let started = 0;
  for (const [i, g] of gates.entries())
    d.enqueue(`lane${i}`, async () => {
      started += 1;
      await g.opened;
    });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, 2);
  assert.equal(d.queued, 1);
  gates[0].release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, 3);
  gates[1].release();
  gates[2].release();
  await d.idle();
  assert.equal(d.running, 0);
});

test("a failing task does not block its lane", async () => {
  const d = new Dispatcher(1);
  const ran: string[] = [];
  d.enqueue("a", async () => {
    throw new Error("boom");
  });
  d.enqueue("a", async () => {
    ran.push("second");
  });
  await d.idle();
  assert.deepEqual(ran, ["second"]);
});

test("idle resolves immediately when nothing is queued", async () => {
  await new Promise<void>((resolve, reject) => {
    new Dispatcher(1).idle().then(resolve, reject);
  });
});

test("a synchronous throw does not wedge its lane", async () => {
  const d = new Dispatcher(1);
  const ran: string[] = [];
  d.enqueue("a", (() => {
    throw new Error("sync boom");
  }) as () => Promise<void>);
  d.enqueue("a", async () => {
    ran.push("second");
  });
  await d.idle();
  assert.deepEqual(ran, ["second"]);
  assert.equal(d.running, 0);
});

test("a wide task takes several slots and is not overtaken by narrow ones", async () => {
  const d = new Dispatcher(3);
  const gates = [gate(), gate(), gate()];
  const started: string[] = [];
  d.enqueue("narrow1", async () => {
    started.push("narrow1");
    await gates[0].opened;
  });
  d.enqueue("narrow2", async () => {
    started.push("narrow2");
    await gates[1].opened;
  });
  // 2 of 3 slots are taken, so the 2-slot task waits, and so does the task
  // queued after it.
  d.enqueue(
    "wide",
    async () => {
      started.push("wide");
      await gates[2].opened;
    },
    2,
  );
  d.enqueue("narrow3", async () => {
    started.push("narrow3");
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["narrow1", "narrow2"]);
  gates[0].release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["narrow1", "narrow2", "wide"]);
  assert.equal(d.running, 2);
  gates[1].release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["narrow1", "narrow2", "wide", "narrow3"]);
  gates[2].release();
  await d.idle();
});

test("a task wider than the cap still runs, alone", async () => {
  const d = new Dispatcher(1);
  const order: string[] = [];
  d.enqueue(
    "wide",
    async () => {
      order.push("wide");
    },
    2,
  );
  d.enqueue("narrow", async () => {
    order.push("narrow");
  });
  await d.idle();
  assert.deepEqual(order, ["wide", "narrow"]);
});

test("drain resolves true once idle and false when the time runs out", async () => {
  const d = new Dispatcher(1);
  assert.equal(await d.drain(1_000), true);
  const g = gate();
  d.enqueue("slow", () => g.opened);
  assert.equal(await d.drain(5), false);
  g.release();
  assert.equal(await d.drain(1_000), true);
});
