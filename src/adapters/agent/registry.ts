import type { AgentAdapter } from "./agent.interface.js";
import type { Config } from "../../config.js";
import { cliAgent } from "./cli-agent.js";
import { log } from "../../log.js";

/**
 * Pick an adapter by name. A new CLI agent is one more branch here with its
 * binary and flags; nothing else in the system knows about specific agents.
 */
export function getAgent(name: string, cfg: Config): AgentAdapter {
  switch (name) {
    case "claude-code":
      return cliAgent({
        name,
        binary: cfg.claudeCodeBin,
        args: ["-p", "--dangerously-skip-permissions"],
      });
    case "codex":
      return cliAgent({
        name,
        binary: cfg.codexBin,
        args: [
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--color",
          "never",
          "-",
        ],
      });
    default:
      log.error("unknown agent adapter", { requested: name });
      throw new Error(
        `Unknown agent adapter "${name}". Expected one of: codex, claude-code.`,
      );
  }
}
