import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeCodeAdapter } from "../src/agents/claude-code.js";
import { codexAdapter } from "../src/agents/codex.js";
import { zcodeAdapter } from "../src/agents/zcode.js";
import type { AgentAdapter } from "../src/agents/types.js";

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
      adapter: codexAdapter({ binary }),
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

test("zcode adapter invokes zcode print mode with prompt on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-fake-zcode-"));
  try {
    const { binary, capturePath } = makeFakeBinary(root);
    const capture = await runAdapter({
      adapter: zcodeAdapter({ binary }),
      capturePath,
      workdir: root,
    });

    assert.deepEqual(capture.argv, ["--print", "--dangerously-skip-permissions"]);
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
      adapter: claudeCodeAdapter({ binary }),
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
