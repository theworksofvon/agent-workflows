import type { AgentAdapter, AgentRunInput } from "../agents/types.js";
import { log } from "../log.js";

/**
 * Runs the agent in the prepared workdir and returns the result. Thin wrapper
 * — orchestration (clone, push, comment) lives in the workflow.
 */
export async function runAgent(
  agent: AgentAdapter,
  input: AgentRunInput,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  log.info("running agent", { agent: agent.name, workdir: input.workdir });
  const res = await agent.run(input);
  log.info("agent finished", {
    agent: agent.name,
    exitCode: res.exitCode,
    stdoutTail: res.stdout.slice(-200),
    stderrTail: res.stderr.slice(-500),
  });
  return res;
}
