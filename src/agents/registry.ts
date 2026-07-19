import type { AgentAdapter } from "./types.js";
import type { Config } from "../config.js";
import { zcodeAdapter } from "./zcode.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { log } from "../log.js";

/**
 * Pick an adapter by name. New adapters register here; nothing else in the
 * system needs to know about specific agents.
 */
export function getAgent(name: string, cfg: Config): AgentAdapter {
  switch (name) {
    case "zcode":
      return zcodeAdapter({ binary: cfg.zcodeBin });
    case "claude-code":
      return claudeCodeAdapter({ binary: cfg.claudeCodeBin });
    case "codex":
      return codexAdapter({ binary: cfg.codexBin });
    default:
      log.error("unknown agent adapter", { requested: name });
      throw new Error(
        `Unknown agent adapter "${name}". Expected one of: codex, claude-code, zcode.`,
      );
  }
}
