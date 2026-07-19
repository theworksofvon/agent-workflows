import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.js";
import { log } from "../log.js";

/**
 * Claude Code adapter — proves the pluggable seam works. Same shape as the
 * ZCode adapter; only the binary + flags differ. Drop-in support for other
 * CLIs is just another file like this one + a registry entry.
 */
export function claudeCodeAdapter(opts: { binary: string }): AgentAdapter {
  return {
    name: "claude-code",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      return new Promise((resolve) => {
        const child = spawn(
          opts.binary,
          ["-p", "--dangerously-skip-permissions"],
          { cwd: input.workdir, stdio: ["pipe", "pipe", "pipe"] },
        );

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("error", (err) => {
          log.error("failed to spawn agent", {
            binary: opts.binary,
            error: String(err),
          });
          resolve({ exitCode: -1, stdout, stderr: stderr + String(err) });
        });

        child.on("close", (code) => {
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });

        child.stdin.end(input.prompt);
      });
    },
  };
}
