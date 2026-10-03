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
