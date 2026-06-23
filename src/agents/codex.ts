import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.js";
import { log } from "../log.js";

/**
 * Codex CLI adapter. Uses `codex exec` so the daemon can run Codex
 * non-interactively inside the isolated checkout.
 */
export function codexAdapter(opts: { binary: string }): AgentAdapter {
  return {
    name: "codex",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      return new Promise((resolve) => {
        const child = spawn(
          opts.binary,
          [
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--color",
            "never",
            "-",
          ],
          { cwd: input.workdir, stdio: ["pipe", "pipe", "pipe"] },
        );

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("error", (err) => {
          log.error("failed to spawn agent", { binary: opts.binary, error: String(err) });
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
