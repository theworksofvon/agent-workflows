import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultDeps,
  serviceManagerFor,
} from "../../src/adapters/service/index.js";
import type { ServiceSpec } from "../../src/adapters/service/service.interface.js";

const spec: ServiceSpec = {
  label: "com.theworksofvon.agent-workflows",
  nodePath: "/usr/bin/node",
  entryPath: "/app/dist/main.js",
  cwd: "/app",
  logDir: "/app/state/logs",
};

function harness(failing: string[] = []) {
  const events: string[] = [];
  const commands: Array<[string, string[]]> = [];
  const deps = {
    run: async (cmd: string, args: string[]) => {
      commands.push([cmd, args]);
      if (failing.includes(cmd)) throw new Error(`${cmd} failed`);
    },
    home: "/home/u",
    writeFile: (p: string, s: string) => events.push(`write:${p}:${s}`),
    mkdir: (p: string) => events.push(`mkdir:${p}`),
    rm: (p: string) => events.push(`rm:${p}`),
    uid: 501,
  };
  return { deps, events, commands };
}

test("launchd renders a plist, escaping values", () => {
  const { deps } = harness();
  const manager = serviceManagerFor("darwin", deps);
  assert.equal(manager.name, "launchd");
  const plist = manager.render({ ...spec, cwd: "/a&b<c>" });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.theworksofvon\./);
  assert.match(plist, /<string>\/app\/dist\/main\.js<\/string>/);
  assert.match(plist, /<string>\/a&amp;b&lt;c&gt;<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /\/app\/state\/logs\/agent-workflows\.log/);
  assert.match(plist, /\/app\/state\/logs\/agent-workflows\.err\.log/);
});

test("launchd install writes the plist then boots out and bootstraps", async () => {
  const { deps, events, commands } = harness();
  const manager = serviceManagerFor("darwin", deps);
  const path = await manager.install(spec);
  const expected =
    "/home/u/Library/LaunchAgents/com.theworksofvon.agent-workflows.plist";
  assert.equal(path, expected);
  assert.equal(manager.unitPath(spec), expected);
  assert.deepEqual(events.slice(0, 1), ["mkdir:/app/state/logs"]);
  assert.equal(events[1], `write:${expected}:${manager.render(spec)}`);
  assert.deepEqual(commands, [
    ["launchctl", ["bootout", "gui/501", expected]],
    ["launchctl", ["bootstrap", "gui/501", expected]],
  ]);
});

test("launchd install tolerates a failing bootout but not a failing bootstrap", async () => {
  let calls = 0;
  const { deps } = harness();
  deps.run = async (_cmd, args) => {
    calls += 1;
    if (args[0] === "bootout") throw new Error("not loaded");
  };
  await serviceManagerFor("darwin", deps).install(spec);
  assert.equal(calls, 2);
  deps.run = async (_cmd, args) => {
    if (args[0] === "bootstrap") throw new Error("denied");
  };
  await assert.rejects(
    serviceManagerFor("darwin", deps).install(spec),
    /denied/,
  );
});

test("launchd uninstall boots out (ignoring failure) and removes the plist", async () => {
  const { deps, events, commands } = harness(["launchctl"]);
  const manager = serviceManagerFor("darwin", deps);
  await manager.uninstall(spec);
  assert.deepEqual(commands, [
    ["launchctl", ["bootout", "gui/501", manager.unitPath(spec)]],
  ]);
  assert.deepEqual(events, [`rm:${manager.unitPath(spec)}`]);
});

test("systemd renders a user unit", () => {
  const manager = serviceManagerFor("linux", harness().deps);
  assert.equal(manager.name, "systemd");
  const unit = manager.render(spec);
  assert.match(unit, /\[Unit\]\nDescription=agent-workflows daemon/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/app\/dist\/main\.js"/);
  assert.match(unit, /WorkingDirectory="\/app"/);
  assert.match(unit, /Restart=always\nRestartSec=5/);
  assert.match(unit, /\[Install\]\nWantedBy=default\.target/);
});

test("systemd quotes and escapes paths with spaces, percent, dollar, and quotes", () => {
  const unit = serviceManagerFor("linux", harness().deps).render({
    ...spec,
    nodePath: "/my node/bin",
    entryPath: '/a b/100%/$HOME/"x"\\y.js',
    cwd: "/w d/%h/$x",
  });
  assert.match(
    unit,
    /^ExecStart="\/my node\/bin" "\/a b\/100%%\/\$\$HOME\/\\"x\\"\\\\y\.js"$/m,
  );
  assert.match(unit, /^WorkingDirectory="\/w d\/%%h\/\$x"$/m);
});

test("systemd install writes the unit then reloads, enables, and lingers", async () => {
  const { deps, events, commands } = harness(["loginctl"]);
  const manager = serviceManagerFor("linux", deps);
  const path = await manager.install(spec);
  const expected = "/home/u/.config/systemd/user/agent-workflows.service";
  assert.equal(path, expected);
  assert.equal(manager.unitPath(spec), expected);
  assert.deepEqual(events, [`write:${expected}:${manager.render(spec)}`]);
  assert.deepEqual(commands, [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", "agent-workflows.service"]],
    ["loginctl", ["enable-linger"]],
  ]);
});

test("systemd uninstall disables (ignoring failure), removes, and reloads", async () => {
  const order: string[] = [];
  const { deps } = harness();
  deps.run = async (_cmd, args) => {
    order.push(`run:${args.join(" ")}`);
    if (args[1] === "disable") throw new Error("not enabled");
  };
  deps.rm = (p) => order.push(`rm:${p}`);
  await serviceManagerFor("linux", deps).uninstall(spec);
  assert.deepEqual(order, [
    "run:--user disable --now agent-workflows.service",
    "rm:/home/u/.config/systemd/user/agent-workflows.service",
    "run:--user daemon-reload",
  ]);
});

test("systemd install and uninstall succeed when every command succeeds", async () => {
  const { deps, commands } = harness();
  const manager = serviceManagerFor("linux", deps);
  await manager.install(spec);
  await manager.uninstall(spec);
  assert.equal(commands.length, 5);
});

test("unsupported platforms throw", () => {
  const { deps } = harness();
  assert.throws(
    () => serviceManagerFor("win32", deps),
    /^Error: Windows is not a supported service target\.$/,
  );
  assert.throws(
    () => serviceManagerFor("freebsd", deps),
    /^Error: Unsupported platform: freebsd$/,
  );
});

test("defaultDeps touches the real filesystem and processes", async () => {
  const deps = defaultDeps();
  const dir = mkdtempSync(join(tmpdir(), "svc-"));
  try {
    const file = join(dir, "a", "b.txt");
    deps.writeFile(file, "hi");
    assert.equal(readFileSync(file, "utf8"), "hi");
    deps.mkdir(join(dir, "m", "n"));
    assert.ok(existsSync(join(dir, "m", "n")));
    deps.rm(file);
    deps.rm(file);
    assert.equal(existsSync(file), false);
    await deps.run(process.execPath, ["-e", ""]);
    await assert.rejects(deps.run(process.execPath, ["-e", "process.exit(3)"]));
    assert.equal(typeof deps.home, "string");
    assert.equal(typeof deps.uid, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultDeps falls back to uid 0 where getuid is unavailable", () => {
  const original = process.getuid;
  Object.defineProperty(process, "getuid", {
    value: undefined,
    configurable: true,
  });
  try {
    assert.equal(defaultDeps().uid, 0);
  } finally {
    Object.defineProperty(process, "getuid", {
      value: original,
      configurable: true,
    });
  }
});
