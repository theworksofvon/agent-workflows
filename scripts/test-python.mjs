#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.platform === "win32" ? "python" : "python3";
const result = spawnSync(
  python,
  [
    "-m",
    "unittest",
    "discover",
    "-s",
    "skills/model-orchestrator/tests",
    "-p",
    "test_*.py",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
