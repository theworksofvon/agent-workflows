# agent-workflows

A local daemon that bridges signals — things that have no native bridge to your coding agents — and routes them to a pluggable coding agent.

**Workflow #1 (built-in):** when a new comment appears on any of your PRs, the daemon creates an isolated git worktree for the PR branch, runs your coding agent with rich context (the comment + PR title/body + file + line + diff hunk), and pushes the resulting commits back to the PR branch.

```
PR comment ─► poll ─► isolated worktree ─► agent (pluggable) ─► push to PR branch
```

## Why

Some agent loops are missing a bridge. Example: agent A opens a PR, agent B pushes a review comment on it — you want a coding agent to notice that comment and act on it automatically. This daemon is that watcher.

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# edit .env: GITHUB_TOKEN, REPOS, AGENT (default: zcode); AGENT_SELF_USER optional

# 3. Run
npm run dev
```

The daemon polls every 60s (configurable). On new comments it will log its progress and act.

## Testing

```bash
npm test
npm run typecheck
```

The default tests do not call GitHub or any LLM API. They use local git repositories/worktrees and fake agent binaries to verify orchestration and adapter behavior without spending tokens. Real agent/API smoke tests should stay opt-in.

## Configuration

All via environment (`.env`):

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | yes | — | PAT with repo + PR comment read/write |
| `REPOS` | yes | — | `owner/repo,owner/repo2` |
| `AGENT_SELF_USER` | no | — | this daemon's GitHub username; when set, comments from it are also ignored. Leave unset for personal-token mode (relies on the marker tag alone) |
| `POLL_INTERVAL_SEC` | no | `60` | seconds between polls |
| `COMMENT_BATCH_WINDOW_SEC` | no | `120` | quiet-window seconds for grouping related comments before running an agent |
| `PR_CONTEXT_HISTORY_LIMIT` | no | `5` | recent PR changelog entries included in an agent prompt |
| `COMMENT_BATCH_HISTORY_LIMIT` | no | `20` | changelog entries retained per PR |
| `PROCESSED_COMMENT_KEY_LIMIT` | no | `2000` | recently handled comment keys retained per repo for duplicate protection |
| `AGENT_RETRY_DELAY_SEC` | no | `1800` | seconds to pause retryable agent failures before trying again |
| `AGENT_MAX_ATTEMPTS` | no | `5` | maximum attempts for a retryable comment batch |
| `AGENT` | no | `zcode` | which adapter: `zcode` \| `claude-code` \| `codex` |
| `STATE_DIR` | no | `./state` | where repo state files, cached bare repos, and worktrees live (gitignored) |
| `ZCODE_BIN` | no | `zcode` | path to the zcode binary |
| `CLAUDE_CODE_BIN` | no | `claude` | path to the claude binary |
| `CODEX_BIN` | no | `codex` | path to the codex binary |
| `KEEP_WORKDIRS` | no | `false` | keep per-task workdirs for debugging |

## Comment batching and loop prevention

New comments are first held in a pending batch. Inline review comments are grouped by GitHub review submission when GitHub provides the review id; otherwise comments are grouped by PR. The daemon waits for `COMMENT_BATCH_WINDOW_SEC` seconds after the latest comment in the group, then emits one workflow event with all comments in that batch.

GitHub state is stored per repo under `state/github/<owner>/<repo>.json`. Each file contains only that repo's cursors, pending comment groups, recent processed comment keys, and bounded per-PR changelog. Agent prompts never receive raw state; they receive only the latest `PR_CONTEXT_HISTORY_LIMIT` changelog entries for the current PR.

Bot-authored top-level conversation comments are ignored, while bot-authored inline review comments remain actionable and are batched by review id.

The daemon posts every summary comment with an invisible HTML marker tag (`<!-- agent-workflows:bot -->`) and skips any comment carrying it, so the agent never reacts to its own output. If `AGENT_SELF_USER` is set, comments authored by that username are ignored too.

Retryable agent failures such as rate limits, usage limits, quota errors, and temporary capacity errors are paused and retried later instead of being marked processed. A batch is marked processed only after the workflow completes.

Leaving `AGENT_SELF_USER` unset enables **personal-token mode**: the daemon authenticates as you, the marker tag is the only loop guard, and your own comments still trigger it. Use a dedicated bot account and set `AGENT_SELF_USER` to its username if you instead want every comment from that account ignored regardless of the marker.

## The four extension seams

Adding new behavior is meant to be small and local:

1. **Sources** (`src/sources/types.ts`) — produce events. Today a GitHub poller.
2. **Workflows** (`src/workflows/`) — handle an event `kind`. Drop a folder in `workflows/`, implement `kind` + `handle`, register it in `workflows/registry.ts`.
3. **Agent adapters** (`src/agents/`) — which CLI does the work. Add a file implementing `AgentAdapter` and register in `agents/registry.ts`.
4. **Worktrees** (`src/runner/workdir.ts`) — where the agent runs. Cached repos plus isolated git worktrees today.

### Example: add a new workflow

```ts
// src/workflows/ci-failed/index.ts
import type { Workflow } from "../types.js";

export function ciFailedWorkflow(): Workflow {
  return {
    kind: "ci_failed",
    async handle(event, ctx) { /* ... */ },
  };
}
```
Then register it in `workflows/registry.ts` alongside `prCommentWorkflow`.

## Safety notes

- The agent runs with unattended permissions in an isolated git worktree. It only touches its managed worktree; the push to the PR uses an explicit `--force-with-lease` pinned to the branch SHA captured when the worktree was created.
- If the agent leaves uncommitted edits, the orchestrator creates a fallback commit before pushing.
- Any comment carrying the marker tag is skipped, as are comments authored by `AGENT_SELF_USER` when it is set.
- Execution is serial — one task at a time — so concurrent PR pushes never race.

## Layout

```
src/
  index.ts          entry: load config, wire everything, start daemon
  daemon.ts         poll loop + serial queue + dispatch
  config.ts         typed env config
  store.ts          generic JSON-backed state helper
  queue.ts          serial task queue
  log.ts            structured logger
  github/           octokit client + PR comment poller
    state.ts        typed per-repo GitHub state files
  sources/          Source seam
  agents/           AgentAdapter seam + zcode/claude-code adapters
  workflows/        Workflow seam + pr-comment/
  runner/           cached repo/worktree preparation + executor
```

## Status

v0.1 — framework + PR-comment workflow + zcode, Claude Code, and Codex adapters. Webhook source, concurrency, and deeper review-comment linking are deliberate follow-ups (the seams already support them).
