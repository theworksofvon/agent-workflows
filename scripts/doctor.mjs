#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
// The Docker image sets this; its configuration comes from the environment.
const inContainer = process.env.AGENT_WORKFLOWS_CONTAINER === "1";
// Like the app: a variable already in the environment wins over .env.
const env = {
  ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value),
  ),
};
let failures = 0;
let warnings = 0;

check(
  Number(process.versions.node.split(".")[0]) === 24,
  `Node ${process.versions.node}`,
  "Node 24 is required",
);
checkCommand("git", ["--version"], "Git");
if (inContainer) pass("Running in the Docker image; .env is not read");
else {
  checkCommand("pnpm", ["--version"], "pnpm");
  check(
    existsSync(envPath),
    ".env exists",
    "Run mise run setup to create .env",
  );
}
check(
  existsSync(join(repoRoot, "dist", "main.js")),
  "Compiled production entrypoint exists",
  "Run mise run build to create dist/main.js",
);

const token = env.GITHUB_TOKEN ?? "";
const ghLogins = ghAccounts();
if (ghLogins.length > 0)
  pass(`gh has a github.com account: ${ghLogins.join(", ")}`);
else warn("gh has no github.com account; run gh auth login");
if (token !== "")
  check(
    token.length > 10 && !/x{4,}|replace|example/i.test(token),
    "GITHUB_TOKEN is configured",
    "Set a non-placeholder GITHUB_TOKEN, or remove it and use gh's accounts",
  );
else
  check(
    ghLogins.length > 0,
    "GITHUB_TOKEN is not set; the app uses gh's accounts",
    "Log in with gh auth login, or set GITHUB_TOKEN",
  );

const allowedAgents = new Set(["codex", "claude-code"]);
const primaryAgent = env.AGENT || "codex";
check(
  allowedAgents.has(primaryAgent),
  `AGENT=${primaryAgent}`,
  `Unsupported AGENT=${primaryAgent}`,
);
const agents = new Set([primaryAgent]);
if (env.REVIEW_ADVERSARIAL_AGENT) agents.add(env.REVIEW_ADVERSARIAL_AGENT);
for (const agent of agents) checkAgent(agent);

const requiredSkills = ["pr-reviewer"];
const skillRoots = {
  codex: [
    join(homedir(), ".agents", "skills"),
    join(env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
  ],
  "claude-code": [
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"),
  ],
};
for (const agent of agents) {
  const roots = skillRoots[agent];
  if (!roots) continue;
  const missing = requiredSkills.filter(
    (s) => !roots.some((root) => existsSync(join(root, s, "SKILL.md"))),
  );
  if (missing.length === 0) pass(`${agent} has the required skill`);
  else
    warn(
      `${agent} is missing the skill: ${missing.join(", ")}; install it from vstack`,
    );
}

if (failures > 0) {
  console.error(
    `\nDoctor found ${failures} blocking problem(s) and ${warnings} warning(s).`,
  );
  process.exit(1);
}
console.log(`\nDoctor passed with ${warnings} warning(s).`);

function checkAgent(agent) {
  const specs = {
    codex: {
      envName: "CODEX_BIN",
      fallback: "codex",
      auth: ["login", "status"],
    },
    "claude-code": {
      envName: "CLAUDE_CODE_BIN",
      fallback: "claude",
      auth: ["auth", "status"],
    },
  };
  const spec = specs[agent];
  if (!spec) {
    fail(`No executable check is available for agent ${agent}`);
    return;
  }
  const binary = env[spec.envName] || spec.fallback;
  const resolved = findExecutable(binary);
  if (!resolved) {
    fail(`${agent} executable not found: ${binary}`);
    return;
  }
  pass(`${agent} executable: ${resolved}`);
  const result = spawnSync(resolved, spec.auth, {
    encoding: "utf8",
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const authenticated =
    result.status === 0 &&
    !/loggedIn"?:\s*false|not logged|authentication required/i.test(output);
  check(
    authenticated,
    `${agent} authentication is available`,
    `${agent} is installed but not authenticated`,
  );
}

/** gh's github.com logins, without letting a token variable stand in. */
function ghAccounts() {
  const gh = findExecutable("gh");
  if (!gh) return [];
  const ghEnv = { ...process.env };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) delete ghEnv[name];
  const result = spawnSync(
    gh,
    [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
      "--jq",
      '[.hosts["github.com"][]? | select(.state == "success") | .login] | join(",")',
    ],
    { encoding: "utf8", timeout: 10_000, env: ghEnv },
  );
  return result.status === 0 && result.stdout.trim() !== ""
    ? result.stdout.trim().split(",")
    : [];
}

function checkCommand(command, args, label) {
  const resolved = findExecutable(command);
  if (!resolved) {
    fail(`${label} executable not found`);
    return;
  }
  const result = spawnSync(resolved, args, {
    encoding: "utf8",
    timeout: 10_000,
  });
  check(
    result.status === 0,
    `${label}: ${(result.stdout || result.stderr).trim()}`,
    `${label} failed to run`,
  );
}

function findExecutable(command) {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(repoRoot, command);
    try {
      accessSync(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch {
      return null;
    }
  }
  const names =
    process.platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`]
      : [command];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function check(condition, success, failure) {
  condition ? pass(success) : fail(failure);
}
function pass(message) {
  console.log(`PASS  ${message}`);
}
function warn(message) {
  warnings += 1;
  console.warn(`WARN  ${message}`);
}
function fail(message) {
  failures += 1;
  console.error(`FAIL  ${message}`);
}
