import "dotenv/config";
import { resolve } from "node:path";
import { log } from "./log.js";
import type { ReviewAdversarialMode } from "./domain/risk.js";

export type { ReviewAdversarialMode };

export interface Config {
  /** Unset when gh's accounts are the only credentials. */
  githubToken: string | undefined;
  /** GitHub's REST and GraphQL API, which a test points at a fake server. */
  githubApiUrl: string;
  agent: string;
  reviewAdversarialMode: ReviewAdversarialMode;
  reviewAdversarialAgent: string;
  stateDir: string;
  claudeCodeBin: string;
  codexBin: string;
  keepWorkdirs: boolean;
  maxConcurrentRuns: number;
  uiHost: string;
  uiPort: number;
  /** The port in the browser's address; UI_PORT unless Docker maps another. */
  uiPublicPort: number;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

/** Every numeric setting goes through here, so all share one error form. */
function integer(
  name: string,
  fallback: string,
  rule: { min: number; max?: number },
): number {
  const { min, max } = rule;
  const value = Number(optional(name, fallback));
  if (
    Number.isInteger(value) &&
    value >= min &&
    (max === undefined || value <= max)
  )
    return value;
  const bound = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
  throw new Error(`${name} must be an integer ${bound}.`);
}

/** Variables that earlier versions read; setting one has no effect now. */
export const RETIRED_VARIABLES = [
  // The feedback bot: polling, webhooks, comment batching, and its service.
  "REPOS",
  "POLL_INTERVAL_SEC",
  "COMMENT_BATCH_WINDOW_SEC",
  "AGENT_MAX_ATTEMPTS",
  "PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN",
  "AGENT_SELF_USER",
  "ALLOWED_AUTHORS",
  "HOST",
  "PORT",
  "WEBHOOK_SECRET",
  "PUBLIC_URL",
  "TAILSCALE_FUNNEL",
  "AUTO_REVIEW",
  "COMMENT_BATCH_HISTORY_LIMIT",
  "PR_CONTEXT_HISTORY_LIMIT",
  "PROCESSED_COMMENT_KEY_LIMIT",
  "COMMENT_BATCH_MIN_COMMENTS",
  "COMMENT_BATCH_MAX_WAIT_SEC",
  "AGENT_RETRY_DELAY_SEC",
  "ZCODE_BIN",
  // The Clef decision engine.
  "DECISION_ENGINE",
  "DECISION_ENGINE_URL",
  "DECISION_MODEL",
  "DECISION_TIMEOUT_MS",
];

/** Each command loads the config once, so this warns once at startup. */
function warnRetired(): void {
  const set = RETIRED_VARIABLES.filter((name) => process.env[name]);
  if (set.length > 0)
    log.warn("these variables are no longer read; remove them from .env", {
      variables: set,
    });
}

/** ZCode support was removed, so an old .env must fail with the fix. */
function agentName(name: string, fallback: string): string {
  const value = optional(name, fallback);
  if (value === "zcode")
    throw new Error(
      `${name}=zcode: ZCode support was removed. Set ${name} to codex or claude-code.`,
    );
  return value;
}

export function loadConfig(): Config {
  warnRetired();
  const agent = agentName("AGENT", "codex");
  const reviewAdversarialMode = optional("REVIEW_ADVERSARIAL_MODE", "auto");
  if (!isReviewAdversarialMode(reviewAdversarialMode)) {
    throw new Error(
      "REVIEW_ADVERSARIAL_MODE must be one of: off, auto, always.",
    );
  }
  const uiPort = integer("UI_PORT", "4773", { min: 1, max: 65535 });
  const cfg: Config = {
    githubToken: optional("GITHUB_TOKEN", "") || undefined,
    githubApiUrl: optional("GITHUB_API_URL", "https://api.github.com"),
    agent,
    reviewAdversarialMode,
    reviewAdversarialAgent: agentName("REVIEW_ADVERSARIAL_AGENT", agent),
    stateDir: resolve(optional("STATE_DIR", "./state")),
    claudeCodeBin: optional("CLAUDE_CODE_BIN", "claude"),
    codexBin: optional("CODEX_BIN", "codex"),
    keepWorkdirs: optional("KEEP_WORKDIRS", "false") === "true",
    maxConcurrentRuns: integer("MAX_CONCURRENT_RUNS", "3", { min: 1 }),
    uiHost: optional("UI_HOST", "127.0.0.1"),
    uiPort,
    uiPublicPort: integer("UI_PUBLIC_PORT", String(uiPort), {
      min: 1,
      max: 65535,
    }),
  };

  log.info("config loaded", {
    agent: cfg.agent,
    reviewAdversarialMode: cfg.reviewAdversarialMode,
    reviewAdversarialAgent: cfg.reviewAdversarialAgent,
    stateDir: cfg.stateDir,
    uiHost: cfg.uiHost,
    uiPort: cfg.uiPort,
    uiPublicPort: cfg.uiPublicPort,
  });
  return cfg;
}

function isReviewAdversarialMode(
  value: string,
): value is ReviewAdversarialMode {
  return value === "off" || value === "auto" || value === "always";
}
