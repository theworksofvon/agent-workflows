# Agentic restructure

Date: 2026-10-02. Status: approved design, awaiting implementation plan.

## Goal

Keep every deterministic step of the PR-automation flow in code, and hand every
judgment call to the coding agent. Restructure the repository into ports and
adapters so the seam between the two is explicit and testable. Move everything
that is a reusable capability out of this repository into vstack, and
everything that is a machine guard into dotfiles.

Non-goals: webhooks, concurrency, fork PR support, new event types. The
existing two flows (PR feedback and PR review) are the whole surface.

## Principle

| Code decides | Agent decides |
| --- | --- |
| Which comments form a batch and when it is ready | Which comments to act on, skip, or escalate, and why |
| Author allowlist and bot filtering | What a comment means and what change it implies |
| Worktree, branch, base SHA | What to inspect, edit, and run |
| Whether anything was committed and whether to push | How many commits and what goes in them |
| What is posted to GitHub and in what shape | The wording of each reply and the summary |
| Retries, cursors, marking processed | Whether a comment is answerable at all |

Inside the task the agent is unconstrained. It runs as a full harness session
in the worktree with its normal tools and the vstack skills loaded. The launch
prompt says only: here is the packet, use the `pr-feedback` skill, write the
report to this path, do not push.

## Layout

Imports point down: main, services, adapters, domain.

```
src/
  main.ts                 CLI entry: daemon | review. Builds Adapters, calls a service.
  config.ts
  domain/
    events.ts             PullRequest, Comment, CommentBatch, ReviewTarget
    decisions.ts          AgentReport, CommentDecision, ReviewFinding; parse + validate
    batching.ts           pure: group, quiet window, min count, max wait
    risk.ts               pure: adversarial decision
    errors.ts             DomainError and subclasses
  services/
    poll.ts               cursors in, ready batches out
    handle-feedback.ts    worktree -> agent -> report -> commit/push/reply
    review-pr.ts          worktree -> agent -> findings -> post
  adapters/
    github/               github.interface.ts + octokit.ts
    git/                  git.interface.ts + exec.ts (clone, worktree, lease push)
    agent/                agent.interface.ts + claude-code.ts, codex.ts, zcode.ts
    state/                state.interface.ts + json-file.ts
tests/
  unit/                   domain and services against fakes
  integration/            temp git repos, fake agent binary, local HTTP GitHub
```

Each `adapters/<role>/` folder holds its interface beside its implementations.
Services are typed only against interfaces. `main.ts` is the one place that
names a concrete implementation. `skills/` is deleted from this repository.

## Contract

Code writes a packet into the run directory inside the worktree:

```json
{
  "repo": "owner/name", "prNumber": 12, "title": "...", "body": "...",
  "headRef": "...", "baseRef": "...", "baseSha": "...",
  "comments": [
    { "key": "owner/name#12:review:991", "author": "...", "kind": "review",
      "path": "src/x.ts", "line": 40, "diffHunk": "...", "body": "..." }
  ],
  "history": [ { "handledAt": "...", "summary": "..." } ],
  "reportPath": ".agent-workflows/report.json"
}
```

The agent writes the report. It is mandatory.

```json
{
  "summary": "one paragraph for the PR comment",
  "comments": [
    { "key": "...", "decision": "addressed", "note": "optional" },
    { "key": "...", "decision": "skipped", "reason": "already handled in abc123" },
    { "key": "...", "decision": "needs_human", "reason": "conflicts with the stated design" }
  ]
}
```

Validation: every comment key in the packet appears exactly once; decision is
one of the three values; `reason` is required for `skipped` and `needs_human`.
Keys the agent omits are recorded as `needs_human` with reason "no decision
reported".

Review mode uses the same mechanism. The agent writes the existing findings
JSON to `reportPath` instead of stdout.

## Deterministic tail

After the agent exits, code does, in order:

1. Read and validate the report.
2. Commit uncommitted changes with a fallback message.
3. If commits are ahead of the fetched base SHA, push with `--force-with-lease`
   pinned to that SHA.
4. Reply on each `skipped` and `needs_human` thread with the agent's reason,
   tagged with the marker.
5. Post one marker summary comment: the agent's summary, commit count, and
   per-decision counts.
6. Record history and mark every comment in the batch processed.

The flow is built to run unattended. The only outputs a human sees are the
summary comment and the per-thread replies.

## Failure policy

Designed so the daemon keeps flowing and nobody is paged.

| Situation | Action |
| --- | --- |
| Agent exits nonzero with a rate-limit signature | Pause batch, retry after `AGENT_RETRY_DELAY_SEC`, up to `AGENT_MAX_ATTEMPTS`. Unchanged. |
| Agent exits but no report | Relaunch once in the same worktree with the prompt "your report at <path> is missing; write it now, change nothing else". |
| Still no report, or report invalid | Discard the worktree. No push. Post one summary: "agent produced no report; batch not applied". Mark processed so the batch does not loop. |
| Report valid, commits exist | Push and post. |
| Report valid, no commits, all decisions `skipped` or `needs_human` | No push. Post replies and summary. |
| Push rejected by lease | Post summary "branch moved during run; changes discarded". Mark processed. |

`needs_human` is a label on a reply, not a stop. The daemon moves on. A later
comment on that thread is just a new comment.

## Trust surface

Deterministic policy, added to `services/poll.ts`:

- `ALLOWED_AUTHORS`: comma-separated GitHub logins. When set, comments from
  anyone else are skipped at poll time and never reach the agent. Unset means
  everyone, which is the current behaviour and is only safe on private repos.
- Existing bot and marker filtering stays.

## What moves where

| Thing | From | To |
| --- | --- | --- |
| Prompt prose in `src/workflows/pr-comment/context.ts` | this repo | vstack `skills/pr-feedback/SKILL.md` (new) |
| `skills/pr-reviewer` | this repo | deleted; vstack copy is identical and already linked |
| `skills/model-orchestrator` | this repo | deleted; vstack copy is newer. Review it separately. |
| `dotfiles/agents/skills/model-orchestrator` | dotfiles | deleted; third copy |
| `scripts/install-shared-skills.*`, skill checks in `doctor.mjs` | this repo | deleted; vstack and `skill-forge` own linking |
| Permission-bypass flags in agent adapters | this repo | stay. They are launch arguments, not guards. Guards are dotfiles hooks and already apply to any session on this machine. |

The `pr-feedback` skill carries: the role, the evidence standard for deciding
addressed vs skipped vs needs_human, the instruction to run the repository's
own validation before committing, and the report schema. It does not carry
anything about pushing, batching, or GitHub.

## Testing

- `domain/`: pure unit tests, including batching windows and report
  validation edge cases (missing keys, duplicate keys, bad decision values).
- `services/`: unit tests against in-memory fakes of every port. Cover each
  row of the failure table.
- `adapters/`: integration tests with temporary git repositories and a fake
  agent binary that writes a scripted report. Local HTTP server for GitHub.
- Coverage gate stays at 100 percent for `src/`.

## Migration order

1. Create `domain/` and `adapters/*/interface.ts` and move existing code into
   the new layout with behaviour unchanged. Tests green.
2. Add `ALLOWED_AUTHORS` to poll.
3. Add report writing to the fake agent, report parsing to `domain/decisions.ts`,
   and the deterministic tail to `handle-feedback.ts`. Replace prompt prose
   with the three-line launch prompt.
4. Write `pr-feedback` skill in vstack (commit on `main`, do not push).
5. Delete `skills/`, skill installer, and doctor skill checks here. Delete the
   dotfiles copy on `agents/hooks-dir`.
6. Update README and CHANGELOG.
7. Before restarting the daemon: move `state/github/EK-LABS-LLC/pluto-predicts.json`
   aside so cursors re-establish, and trim `REPOS` or set `ALLOWED_AUTHORS`
   for the public repositories.

## Follow-ups, out of scope here

- Review and update vstack `model-orchestrator`: the profiles config is new and
  untested against real CLIs; `provider-adapters.md` names model IDs that drift.
- Review mode could adopt the same per-finding decision shape for adversarial
  passes.
