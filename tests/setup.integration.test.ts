import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("clean setup builds production output and links every portable skill", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-clean-setup-"));
  const checkout = join(root, "checkout");
  const testHome = join(root, "home");

  try {
    mkdirSync(checkout, { recursive: true });
    mkdirSync(testHome, { recursive: true });
    for (const file of [
      ".env.example",
      "package.json",
      "pnpm-workspace.yaml",
      "tsconfig.json",
    ]) {
      copyFileSync(join(repoRoot, file), join(checkout, file));
    }
    for (const directory of ["scripts", "skills", "src"]) {
      cpSync(join(repoRoot, directory), join(checkout, directory), {
        recursive: true,
      });
    }
    symlinkSync(
      join(repoRoot, "node_modules"),
      join(checkout, "node_modules"),
      "dir",
    );

    const first = runSetup(checkout, testHome);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(existsSync(join(checkout, "dist", "index.js")), true);
    assert.equal(
      readFileSync(join(checkout, ".env"), "utf8"),
      readFileSync(join(checkout, ".env.example"), "utf8"),
    );

    const skillNames = ["model-orchestrator", "pr-reviewer"];
    for (const runtime of [".codex", ".claude", ".cursor"]) {
      for (const skillName of skillNames) {
        assert.equal(
          realpathSync(join(testHome, runtime, "skills", skillName)),
          realpathSync(join(checkout, "skills", skillName)),
        );
      }
    }

    writeFileSync(join(checkout, ".env"), "KEEP_EXISTING=true\n");
    const second = runSetup(checkout, testHome);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(
      readFileSync(join(checkout, ".env"), "utf8"),
      "KEEP_EXISTING=true\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runSetup(checkout: string, testHome: string) {
  return spawnSync(
    process.execPath,
    [join(checkout, "scripts", "setup.mjs"), "--skip-install"],
    {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: testHome,
      },
    },
  );
}
