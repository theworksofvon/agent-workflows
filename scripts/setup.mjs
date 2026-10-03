#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.argv.includes("--skip-install");
const nodeMajor = Number(process.versions.node.split(".")[0]);
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (nodeMajor !== 24) {
  console.error(`Node 24 is required; found ${process.versions.node}.`);
  process.exit(1);
}

if (!skipInstall) {
  run(packageManager, ["install", "--frozen-lockfile"]);
}

// Invoke the compiler directly: `pnpm exec` insists on re-checking the
// modules directory, which needs a TTY and fails under the setup test.
run(process.execPath, [
  join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
]);

const envPath = join(repoRoot, ".env");
if (!existsSync(envPath)) {
  copyFileSync(join(repoRoot, ".env.example"), envPath);
  console.log(
    "Created .env from .env.example; replace the placeholder values before running.",
  );
} else {
  console.log("Kept existing .env.");
}

console.log(
  "\nSetup complete. Edit .env, authenticate the selected agent CLI, install the pr-feedback and pr-reviewer skills from vstack into your harness, then run: mise run doctor",
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
