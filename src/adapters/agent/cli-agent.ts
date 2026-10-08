import { spawn } from "node:child_process";
import type { AgentAdapter } from "./agent.interface.js";
import { log } from "../../log.js";

/** Callers read only the end of each stream, so a long run keeps no more. */
export const OUTPUT_TAIL_CHARS = 64 * 1024;

/**
 * Runs a CLI coding agent headless in the workdir. The prompt goes through
 * stdin to avoid argv length limits and keep it out of process listings. A
 * nonzero exit is returned, not thrown: the workflow decides what it means.
 */
export function cliAgent(opts: {
  name: string;
  binary: string;
  args: string[];
}): AgentAdapter {
  return {
    name: opts.name,
    run(input) {
      log.info("running agent", { agent: opts.name, workdir: input.workdir });
      return new Promise((resolve) => {
        const child = spawn(opts.binary, opts.args, {
          cwd: input.workdir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = outputTail();
        const stderr = outputTail();
        child.stdout.on("data", stdout.add);
        child.stderr.on("data", stderr.add);
        child.on("error", (err) => {
          log.error("failed to spawn agent", {
            binary: opts.binary,
            error: String(err),
          });
          resolve({
            exitCode: -1,
            stdout: stdout.text(),
            stderr: stderr.text() + String(err),
          });
        });
        child.on("close", (code) => {
          const result = {
            exitCode: code ?? -1,
            stdout: stdout.text(),
            stderr: stderr.text(),
          };
          log.info("agent finished", {
            agent: opts.name,
            exitCode: result.exitCode,
            stdoutTail: result.stdout.slice(-200),
            stderrTail: result.stderr.slice(-500),
          });
          resolve(result);
        });
        child.stdin.end(input.prompt);
      });
    },
  };
}

function outputTail(): { add(chunk: Buffer): void; text(): string } {
  let kept = "";
  return {
    add: (chunk) => {
      kept = (kept + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    },
    text: () => kept,
  };
}
