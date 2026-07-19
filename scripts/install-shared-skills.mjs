#!/usr/bin/env node
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = join(repoRoot, "skills");
const targets = [
  join(homedir(), ".codex", "skills"),
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".cursor", "skills"),
];

const skills = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fileExists(join(sourceDir, name, "SKILL.md")))
  .sort();

if (skills.length === 0) {
  throw new Error(`No portable skills found under ${sourceDir}`);
}

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  for (const skillName of skills) {
    const source = join(sourceDir, skillName);
    const target = join(targetDir, skillName);
    installLink(source, target);
    console.log(`${target} -> ${source}`);
  }
}

function installLink(source, target) {
  if (fileExists(target, false)) {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) {
      console.warn(`skip: ${target} exists and is not a symlink`);
      return;
    }
    const current = resolve(dirname(target), readlinkSync(target));
    if (realpathOrResolved(current) === realpathOrResolved(source)) return;
    unlinkSync(target);
  }
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

function fileExists(path, followLinks = true) {
  try {
    followLinks ? realpathSync(path) : lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realpathOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
