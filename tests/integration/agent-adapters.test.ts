import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OUTPUT_TAIL_CHARS,
  cliAgent,
} from "../../src/adapters/agent/cli-agent.js";
import { getAgent } from "../../src/adapters/agent/registry.js";
import type { AgentAdapter } from "../../src/adapters/agent/agent.interface.js";
import type { Config } from "../../src/config.js";

/** The registry reads only the binary paths from the config. */
function agentFor(name: string, binary: string): AgentAdapter {
  return getAgent(name, { codexBin: binary, claudeCodeBin: binary } as Config);
}

interface Capture {
  argv: string[];
  cwd: string;
  stdin: string;
}

function makeFakeBinary(root: string): { binary: string; capturePath: string } {
  const capturePath = join(root, "capture.json");
  const binary = join(root, "fake-agent.js");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_AGENT_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
  }, null, 2));
  process.stderr.write("fake warning\\n");
  process.stdout.write("fake agent complete\\n");
});
`,
  );
  chmodSync(binary, 0o755);
  return { binary, capturePath };
}

async function runAdapter(args: {
  adapter: AgentAdapter;
  capturePath: string;
  workdir: string;
}): Promise<Capture> {
  const previousCapture = process.env.FAKE_AGENT_CAPTURE;
  process.env.FAKE_AGENT_CAPTURE = args.capturePath;
  try {
    const result = await args.adapter.run({
      workdir: args.workdir,
      branch: "feature/test",
      prompt: "review prompt",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /fake agent complete/);
    assert.match(result.stderr, /fake warning/);
    return JSON.parse(readFileSync(args.capturePath, "utf8")) as Capture;
  } finally {
    if (previousCapture === undefined) {
      delete process.env.FAKE_AGENT_CAPTURE;
    } else {
      process.env.FAKE_AGENT_CAPTURE = previousCapture;
    }
  }
}

test("codex adapter invokes codex exec with prompt on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-fake-codex-"));
  try {
    const { binary, capturePath } = makeFakeBinary(root);
    const capture = await runAdapter({
      adapter: agentFor("codex", binary),
      capturePath,
      workdir: root,
    });

    assert.deepEqual(capture.argv, [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color",
      "never",
      "-",
    ]);
    assert.equal(capture.cwd, realpathSync(root));
    assert.equal(capture.stdin, "review prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code adapter invokes claude print mode with prompt on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-fake-claude-"));
  try {
    const { binary, capturePath } = makeFakeBinary(root);
    const capture = await runAdapter({
      adapter: agentFor("claude-code", binary),
      capturePath,
      workdir: root,
    });

    assert.deepEqual(capture.argv, ["-p", "--dangerously-skip-permissions"]);
    assert.equal(capture.cwd, realpathSync(root));
    assert.equal(capture.stdin, "review prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI agent reports spawn errors and signal exits without invoking a real agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-agent-errors-"));
  try {
    const signalBinary = join(root, "signal-agent.js");
    writeFileSync(
      signalBinary,
      "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
    );
    chmodSync(signalBinary, 0o755);
    const run = (binary: string) =>
      cliAgent({ name: "fake", binary, args: [] }).run({
        workdir: root,
        branch: "feature",
        prompt: "prompt",
      });
    const missing = await run(join(root, "does-not-exist"));
    assert.equal(missing.exitCode, -1);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal((await run(signalBinary)).exitCode, -1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI agent keeps only the tail of a long output", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-agent-tail-"));
  try {
    const binary = join(root, "loud-agent.js");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdout.write("a".repeat(${OUTPUT_TAIL_CHARS}) + "end");
process.stderr.write("b".repeat(${OUTPUT_TAIL_CHARS}) + "err");
`,
    );
    chmodSync(binary, 0o755);
    const result = await cliAgent({ name: "loud", binary, args: [] }).run({
      workdir: root,
      branch: "feature",
      prompt: "",
    });
    assert.equal(result.stdout.length, OUTPUT_TAIL_CHARS);
    assert.ok(result.stdout.endsWith("aend"));
    assert.equal(result.stderr.length, OUTPUT_TAIL_CHARS);
    assert.ok(result.stderr.endsWith("berr"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
