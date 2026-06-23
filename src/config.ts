import "dotenv/config";
import { resolve } from "node:path";
import { log } from "./log.js";

export interface RepoSpec {
  owner: string;
  repo: string;
}

export interface Config {
  githubToken: string;
  repos: RepoSpec[];
  pollIntervalSec: number;
  commentBatchWindowSec: number;
  prContextHistoryLimit: number;
  commentBatchHistoryLimit: number;
  processedCommentKeyLimit: number;
  agent: string;
  agentSelfUser: string;
  stateDir: string;
  zcodeBin: string;
  claudeCodeBin: string;
  codexBin: string;
  keepWorkdirs: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function parseRepos(raw: string): RepoSpec[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((slug) => {
      const parts = slug.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo slug "${slug}" — expected "owner/repo".`);
      }
      return { owner: parts[0], repo: parts[1] };
    });
}

export function loadConfig(): Config {
  const cfg: Config = {
    githubToken: required("GITHUB_TOKEN"),
    repos: parseRepos(required("REPOS")),
    pollIntervalSec: Number(optional("POLL_INTERVAL_SEC", "60")),
    commentBatchWindowSec: Number(optional("COMMENT_BATCH_WINDOW_SEC", "120")),
    prContextHistoryLimit: Number(optional("PR_CONTEXT_HISTORY_LIMIT", "5")),
    commentBatchHistoryLimit: Number(optional("COMMENT_BATCH_HISTORY_LIMIT", "20")),
    processedCommentKeyLimit: Number(optional("PROCESSED_COMMENT_KEY_LIMIT", "2000")),
    agent: optional("AGENT", "zcode"),
    agentSelfUser: required("AGENT_SELF_USER"),
    stateDir: resolve(optional("STATE_DIR", "./state")),
    zcodeBin: optional("ZCODE_BIN", "zcode"),
    claudeCodeBin: optional("CLAUDE_CODE_BIN", "claude"),
    codexBin: optional("CODEX_BIN", "codex"),
    keepWorkdirs: optional("KEEP_WORKDIRS", "false") === "true",
  };

  if (!Number.isFinite(cfg.pollIntervalSec) || cfg.pollIntervalSec < 5) {
    throw new Error("POLL_INTERVAL_SEC must be a number >= 5.");
  }
  if (!Number.isFinite(cfg.commentBatchWindowSec) || cfg.commentBatchWindowSec < 0) {
    throw new Error("COMMENT_BATCH_WINDOW_SEC must be a number >= 0.");
  }
  if (!Number.isInteger(cfg.prContextHistoryLimit) || cfg.prContextHistoryLimit < 0) {
    throw new Error("PR_CONTEXT_HISTORY_LIMIT must be an integer >= 0.");
  }
  if (!Number.isInteger(cfg.commentBatchHistoryLimit) || cfg.commentBatchHistoryLimit < 0) {
    throw new Error("COMMENT_BATCH_HISTORY_LIMIT must be an integer >= 0.");
  }
  if (!Number.isInteger(cfg.processedCommentKeyLimit) || cfg.processedCommentKeyLimit < 0) {
    throw new Error("PROCESSED_COMMENT_KEY_LIMIT must be an integer >= 0.");
  }
  if (cfg.repos.length === 0) {
    throw new Error("REPOS must list at least one owner/repo.");
  }

  log.info("config loaded", {
    repos: cfg.repos.map((r) => `${r.owner}/${r.repo}`),
    agent: cfg.agent,
    pollIntervalSec: cfg.pollIntervalSec,
    commentBatchWindowSec: cfg.commentBatchWindowSec,
    prContextHistoryLimit: cfg.prContextHistoryLimit,
    stateDir: cfg.stateDir,
  });
  return cfg;
}
