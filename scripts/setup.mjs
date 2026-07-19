#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.argv.includes("--skip-install");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor !== 24) {
  console.error(`Node 24 is required; found ${process.versions.node}.`);
  process.exit(1);
}

if (!skipInstall) {
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"]);
}

run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);

const envPath = join(repoRoot, ".env");
if (!existsSync(envPath)) {
  copyFileSync(join(repoRoot, ".env.example"), envPath);
  console.log("Created .env from .env.example; replace the placeholder values before running.");
} else {
  console.log("Kept existing .env.");
}

run(process.execPath, [join(repoRoot, "scripts", "install-shared-skills.mjs")]);
console.log("\nSetup complete. Edit .env, authenticate the selected agent CLI, then run: npm run doctor");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
