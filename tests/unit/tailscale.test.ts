import test from "node:test";
import assert from "node:assert/strict";
import { execRun, tailscaleCli } from "../../src/adapters/tailscale/cli.js";

type Reply = { stdout: string; exitCode: number };

function fakeRun(replies: Reply[]) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<Reply> => {
    calls.push(args);
    return replies.shift() ?? { stdout: "", exitCode: 0 };
  };
  return { run, calls };
}

const STATUS = JSON.stringify({ Self: { DNSName: "box.tailnet.ts.net." } });

test("funnelOn enables funnel then derives the https URL from status", async () => {
  const fake = fakeRun([
    { stdout: "", exitCode: 0 },
    { stdout: STATUS, exitCode: 0 },
  ]);
  const url = await tailscaleCli(fake.run).funnelOn(3773);
  assert.equal(url, "https://box.tailnet.ts.net");
  assert.deepEqual(fake.calls, [
    ["funnel", "--bg", "3773"],
    ["status", "--json"],
  ]);
});

test("funnelOn fails on a non-zero funnel exit and on a missing DNSName", async () => {
  await assert.rejects(
    tailscaleCli(fakeRun([{ stdout: "", exitCode: 2 }]).run).funnelOn(1),
    /tailscale funnel failed \(exit 2\)/,
  );
  await assert.rejects(
    tailscaleCli(
      fakeRun([
        { stdout: "", exitCode: 0 },
        { stdout: "{}", exitCode: 0 },
      ]).run,
    ).funnelOn(1),
    /DNSName/,
  );
  await assert.rejects(
    tailscaleCli(
      fakeRun([
        { stdout: "", exitCode: 0 },
        { stdout: "", exitCode: 1 },
      ]).run,
    ).funnelOn(1),
    /tailscale status failed \(exit 1\)/,
  );
});

test("a missing binary is reported as not installed", async () => {
  const run = async (): Promise<Reply> => {
    throw new Error("spawn tailscale ENOENT");
  };
  await assert.rejects(
    tailscaleCli(run).funnelOn(1),
    /tailscale is not installed or not on PATH: spawn tailscale ENOENT/,
  );
  await assert.rejects(
    tailscaleCli(async () => {
      throw "boom";
    }).currentUrl(),
    /not installed or not on PATH: boom/,
  );
});

test("funnelOff passes off and tolerates a non-zero exit", async () => {
  const fake = fakeRun([{ stdout: "", exitCode: 1 }]);
  await tailscaleCli(fake.run).funnelOff(3773);
  assert.deepEqual(fake.calls, [["funnel", "--bg", "3773", "off"]]);
  await tailscaleCli(fakeRun([{ stdout: "", exitCode: 0 }]).run).funnelOff(1);
});

test("currentUrl reads status without touching funnel", async () => {
  const fake = fakeRun([{ stdout: STATUS, exitCode: 0 }]);
  assert.equal(
    await tailscaleCli(fake.run).currentUrl(),
    "https://box.tailnet.ts.net",
  );
  assert.deepEqual(fake.calls, [["status", "--json"]]);
});

test("execRun resolves exit codes and rejects when the binary is missing", async () => {
  const run = execRun(process.execPath);
  assert.deepEqual(await run(["-e", "process.stdout.write('hi')"]), {
    stdout: "hi",
    exitCode: 0,
  });
  assert.equal((await run(["-e", "process.exit(3)"])).exitCode, 3);
  await assert.rejects(execRun("no-such-binary-agent-workflows")(["x"]));
});
