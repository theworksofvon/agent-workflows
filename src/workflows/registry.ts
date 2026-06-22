import type { Workflow } from "./types.js";
import { prCommentWorkflow } from "./pr-comment/index.js";

const registry = new Map<string, Workflow>();

export function registerWorkflow(wf: Workflow): void {
  if (registry.has(wf.kind)) {
    throw new Error(`Workflow already registered for kind "${wf.kind}".`);
  }
  registry.set(wf.kind, wf);
}

export function getWorkflow(kind: string): Workflow | undefined {
  return registry.get(kind);
}

/** Register all built-in workflows. Call once at startup. */
export function registerBuiltins(): void {
  registerWorkflow(prCommentWorkflow());
}
