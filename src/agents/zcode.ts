import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types.js";
import { log } from "../log.js";

/**
 * ZCode CLI adapter. Runs the agent headless against the workdir with the
 * assembled prompt. Non-zero exit is surfaced but not fatal — the workflow
 * decides whether to push.
 */
export function zcodeAdapter(opts: { binary: string }): AgentAdapter {
  return {
    name: "zcode",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      // Pass the prompt via stdin to avoid argv length limits and keep the
      // prompt out of process listings.
      return new Promise((resolve) => {
        const child = spawn(
          opts.binary,
          ["--print", "--dangerously-skip-permissions"],
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
