/**
 * Agent adapter seam — which CLI coding agent does the work.
 *
 * The app is agnostic: it hands the adapter an isolated workdir + a branch
 * + a prompt, and gets back the process result. The agent reads the workdir
 * and writes its report; the workflow refuses a run that changed files.
 */
export interface AgentRunInput {
  /** Absolute path to the isolated git checkout. */
  workdir: string;
  /** Branch already checked out in the workdir. */
  branch: string;
  /** Assembled context/prompt for this task. */
  prompt: string;
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
