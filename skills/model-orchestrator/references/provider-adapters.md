# Provider adapters

This skill is provider-neutral. Model labels such as `claude`, `codex`, or `gpt` are aliases only; resolve them through tools or CLIs installed in the current environment.

## Claude Code

Use Claude Code only when its CLI or connected interface is available and authenticated. A Claude-led session can own discovery/planning and invoke a configured implementation or review runner. If Claude Code cannot directly invoke another model, emit the implementer packet for the user to run, then resume from the returned diff and test log.

## Codex

Use the available Codex surface or CLI and its configured model selection. “Codex” does not identify a single model or guarantee access to every model family. For cost-sensitive implementation, choose the lowest-cost model that meets the task’s reasoning, context, tool-use, and reliability needs; retain a stronger reviewer when risk warrants it.

## Other backends

Treat any other provider, local model, agent framework, or script as an adapter with four properties: invocation method, model identifier, input/output format, and usage/cost reporting. Never expose credentials in packets. If an adapter changes files, require a diff or precise changed-file list and command log.

## User-run bridge

When no direct bridge exists, provide a copyable stage prompt containing the packet, ask the user to run it in the other tool, and request the resulting plan, diff, review, or test log. Continue from that artifact; do not fabricate completion.

## Model selection rubric

| Need | Prefer |
|---|---|
| Ambiguous requirements, architecture, migration, threat modeling | strongest available planner |
| Mechanical edits with clear acceptance tests | lower-cost implementer |
| Independent correctness and regression review | different model/provider when practical |
| Novel, security-sensitive, or failed repair | stronger implementer/reviewer and tighter human checkpoints |

Record the model identifier, reason for selection, and usage/cost if exposed. If usage is not exposed, state that it is unavailable rather than estimating it as fact.
