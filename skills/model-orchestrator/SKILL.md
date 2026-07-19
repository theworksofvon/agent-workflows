---
name: model-orchestrator
description: Orchestrate long-running software tasks across multiple AI coding agents or model backends by assigning planning, implementation, review, testing, and repair roles; use when a user wants Claude, Codex, or other models to collaborate with explicit handoffs, model-cost tradeoffs, and durable progress artifacts.
---

# Model Orchestrator

## Purpose

This skill is the portable orchestration layer for a controlled software task:

`discover → plan → approve → implement → test → review → repair → verify`

Route broad/ambiguous direction to Fable 5 and technical direction to Sol 5.6 when those aliases are configured. Use Codex Medium as the default implementer and Cursor CLI as an alternate implementer or independent reviewer. Provider-specific names are configuration, not assumptions.

When shell access exists, invoke `scripts/mo.py run-stage` for every delegated stage. It records the invocation, timing, normalized usage, cost provenance, raw output, and checkpoint. The utility is also available as `mo usage`, `mo report TASK-123`, `mo export`, and `mo dashboard`; it uses only the Python standard library and does not require Pulse. If the harness cannot execute a CLI, use the manual handoff protocol and preserve the packet instead.

## Operating rules

- Treat the repository, branch, uncommitted changes, tool availability, and user constraints as shared state. Inspect them before assigning work.
- Keep role boundaries explicit. A planner produces a plan; an implementer changes files; a reviewer diagnoses against acceptance criteria.
- Prefer a strong model for ambiguous architecture, a lower-cost model for well-specified mechanical implementation, and an independent model for review. Escalate quality-sensitive work rather than optimizing cost blindly.
- Pass compact, durable artifacts between stages. Include task statement, repository facts, acceptance criteria, decisions, changed files, commands run, failures, and open questions.
- Do not send secrets, credentials, private prompts, or unnecessary repository contents to another backend.
- The user remains the authority for scope changes, destructive operations, external messages, deployments, and merges. Ask before those actions.
- Run tests and inspect the diff after implementation and after every repair cycle. A review approval is not a substitute for verification.
- Keep implementation and review in separate provider/session contexts; never review a change using the same context that authored it when an independent context is available.
- Never claim exact tokens or cost unless the provider reported them. Label values `exact`, `estimated` (rate-card calculation), or `unavailable` separately.
- Pause only at risk-based approval gates: scope or architecture changes, destructive operations, external messages/deployments/merges, budget overruns, or repeated repair disagreement.

## Select the workflow

For a small, local, well-defined change, use one capable agent and a lightweight review. For a long-running or high-risk task, use the full pipeline. Parallelize only independent discovery or review work; serialize edits to avoid conflicting changes.

Before starting, identify the planner, implementer, reviewer, repair policy, and budget or cost ceiling if known. If the user names only a provider, resolve the concrete model from `.orchestrator/config.toml`, an available tool, or CLI configuration and report the resolution. Never infer that “Codex” means one fixed model.

## Standard pipeline

### 1. Discover

Inspect the repository and task context. Establish the baseline branch/status, relevant files, existing tests, and available model interfaces. Record facts, not guesses. If the task is underspecified, ask only the question that blocks safe planning; otherwise state assumptions in the packet.

### 2. Plan

Give the planner only necessary context and ask for the goal/non-goals, current-state findings, proposed design, ordered file-level steps, acceptance criteria, test strategy, risks, rollback notes, and unresolved questions. Do not modify product code in this stage.

### 3. Approve and hand off

Present a concise plan summary, assumptions, selected models, and expected cost/quality tradeoff. Wait for approval when the plan changes scope, architecture, public interfaces, data, or external state. Then create an implementer packet using [handoff-protocol.md](references/handoff-protocol.md).

### 4. Implement

Instruct the implementer to follow the approved plan, inspect before editing, make the smallest coherent change, preserve unrelated user work, and report every changed file and command. A lower-cost implementer is appropriate only when the plan and acceptance criteria are concrete.

### 5. Test

Run the narrowest relevant checks first, then broader checks proportional to risk. Capture exact commands and results. Distinguish “not run,” “blocked,” and “failed.”

### 6. Review

Give the reviewer the approved plan, acceptance criteria, diff, test results, and relevant context—not private reasoning. Ask for findings ranked by severity, with file/line evidence and concrete fixes. Require checks for correctness, regressions, security/privacy, maintainability, tests, and scope drift.

### 7. Repair and verify

Hand actionable findings and needed context to the implementer, or send design-level issues back to the planner. Re-run tests and an independent review when changes are material. Limit repair cycles and surface repeated disagreement to the user.

## Provider and model handoffs

Use the provider-specific mechanism that is actually available: connected model tools, a local CLI, an API wrapper, or a user-run handoff. Translate the same packet into that mechanism rather than coupling the workflow to Claude or Codex. Read [provider-adapters.md](references/provider-adapters.md) when the user asks about Claude Code, Codex CLI, model aliases, or running a stage outside this session. For local commands, configure provider templates under `[providers]` and model aliases under `[models]` in `.orchestrator/config.toml`; pass packets through stdin and use `{task_id}`, `{run_id}`, `{stage}`, `{model}`, `{input_file}`, and `{run_dir}` placeholders when useful.

The helper lives at `model-orchestrator/scripts/mo.py`. A project using the skill may copy or expose it as `mo`; raw provider commands are an adapter/debugging detail and should not be part of normal user instructions. Its append-only ledger and run artifacts are normally ignored by git. A checkpoint permits an interrupted stage to be resumed with the same run ID; successful resumed stages are not invoked twice.

For a Claude-led workflow, Claude may own discovery/planning and delegate implementation or review to callable Codex/model interfaces. For a Codex-led workflow, Codex may delegate planning or review to Claude/another backend when configured. Preserve the same packet schema in both directions and keep authority with the user.

## Completion report

End with selected roles/models and why; completed stages; files changed; test/review outcome; remaining risks; exact/estimated/unavailable usage and cost; and the next user decision, if any. Do not claim cross-model execution occurred unless it actually did.
