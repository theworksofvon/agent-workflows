# agent-workflows

Connect GitHub pull-request activity to local coding agents, run structured PR
reviews, and share portable agent skills across Codex, Claude Code, and Cursor.

## What it offers

| Capability            | What happens                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR comment automation | Polls watched repositories, batches related feedback, runs an agent in an isolated worktree, and safely pushes resulting commits back to the PR branch.                                                      |
| Manual PR review      | Runs a read-only review against any accessible PR. It prints findings by default and can post one grouped GitHub review with `--post`.                                                                       |
| Adversarial review    | Optionally sends the primary result through an independent verification pass for large, sensitive, or high-severity changes.                                                                                 |
| Shared agent skills   | Keeps repository-owned `SKILL.md` packages identical across Codex, Claude Code, and Cursor through personal-directory links.                                                                                 |
| Model orchestration   | Provides a portable planning → implementation → test → review → repair workflow with stage artifacts, usage records, and resumable checkpoints. Provider commands still need project-specific configuration. |

```text
PR feedback → poll and batch → isolated worktree → coding agent → guarded push
                                              ↘ review-only → findings/review
```

## Clean install

### Prerequisites

- Git
- Node 24 and pnpm 11 (`.nvmrc` and `package.json` pin the supported runtime)
- A GitHub token
- At least one supported agent CLI: Codex, Claude Code, or ZCode
- Python 3.11+ only when using the model-orchestrator telemetry runner

### 1. Set up the repository

```bash
git clone <repository-url>
cd agent-workflows
nvm use                       # or install Node 24 another way
corepack enable
corepack install --global pnpm@11.15.0
pnpm run setup
```

`pnpm run setup` installs locked dependencies, builds production JavaScript,
creates `.env` without overwriting an existing one, and links portable skills
into the personal skill directories for Codex, Claude Code, and Cursor.

### 2. Authenticate an agent

Choose the adapter you will put in `.env`:

```bash
codex login                   # AGENT=codex
claude auth login             # AGENT=claude-code
```

ZCode users must install and authenticate its CLI separately.

### 3. Configure GitHub

Edit `.env`. The minimum daemon configuration is:

```dotenv
GITHUB_TOKEN=replace-me
REPOS=owner/repo,owner/another-repo
AGENT=codex
```

The token must be able to read PRs and comments, create comments/reviews, clone
the repository, and push to its PR branches. For a fine-grained token this
normally means repository Contents, Pull requests, and Issues read/write access.

### 4. Verify and run

```bash
pnpm run doctor
pnpm start
```

`doctor` checks the runtime, Git, `.env`, the selected agent executable and
authentication, and shared skill links without making GitHub or model calls.

The daemon polls every 60 seconds by default. Keep it under your preferred
service manager if it must survive terminal exits or machine restarts.

## Common commands

| Command                             | Purpose                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm run setup`                    | Install dependencies, create `.env`, and install shared skills.                    |
| `pnpm run doctor`                   | Validate a machine before starting the daemon.                                     |
| `pnpm build`                        | Compile TypeScript and source maps into `dist/`.                                   |
| `pnpm start`                        | Run the compiled daemon with Node.                                                 |
| `pnpm dev`                          | Run with source watching.                                                          |
| `pnpm review owner/repo#123`        | Review a PR locally without posting or changing files.                             |
| `pnpm review owner/repo#123 --post` | Post new actionable findings as one grouped review.                                |
| `pnpm skills:install`               | Refresh Codex, Claude, and Cursor links after adding a skill.                      |
| `pnpm test:unit`                    | Run fast unit tests.                                                               |
| `pnpm test:integration`             | Run local integration tests, including clean setup and temporary Git repositories. |
| `pnpm test:e2e`                     | Run the deterministic HTTP, Git, daemon, and fake-agent end-to-end scenario.       |
| `pnpm test`                         | Run all 60 Node tests with exact 100% coverage for production TypeScript.          |
| `pnpm test:smoke`                   | Exercise compiled CLI help routes without credentials or network access.           |
| `pnpm test:python`                  | Run the Python model-orchestrator test suite.                                      |
| `pnpm lint`                         | Run ESLint across TypeScript and Node scripts.                                     |
| `pnpm format:check`                 | Verify repository formatting with Prettier.                                        |

Review targets can also be full GitHub PR URLs. Use `--adversarial` or
`--no-adversarial` to override the configured review policy. See
[docs/pr-review-mode.md](docs/pr-review-mode.md).

The compiled production process remains terminal-friendly: logs stream live,
`Ctrl+C` performs graceful shutdown, and child agent/Git processes behave the
same as in development. Use `pnpm dev` when automatic restart after source
edits is desired.

## Token-aware comment batching

Immediate event delivery does not imply one model call per comment. Every event
source feeds the same batch gate:

1. Related comments are grouped by PR conversation or GitHub review ID.
2. A 10-second quiet period absorbs comments arriving together.
3. Two related comments make the batch eligible to run.
4. A lone comment runs after five minutes so important feedback is not ignored.

The defaults can be adjusted with `COMMENT_BATCH_WINDOW_SEC`,
`COMMENT_BATCH_MIN_COMMENTS`, and `COMMENT_BATCH_MAX_WAIT_SEC`. Future webhook
delivery will reuse this gate; webhooks will remove polling latency without
bypassing token controls.

## Safe first startup and state

Runtime state lives under `STATE_DIR` (`./state` by default) and is intentionally
not committed. It contains polling cursors, pending batches, duplicate guards,
review history, cached bare repositories, and managed worktrees.

A new state directory establishes cursors on its first successful poll and
does **not** process comments that already existed. New comments are handled
normally afterward. To intentionally process existing comments, set:

```dotenv
PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN=true
```

When moving a running daemon to another machine, copy `state/github/` while the
old daemon is stopped. Cached repositories and worktrees can be recreated.
Never run two daemon instances against the same repositories and state history.

## Shared skills

Portable skills live under `skills/` as the single source of truth:

- `model-orchestrator` — staged multi-model planning, implementation, review,
  repair, telemetry, and handoffs.
- `pr-reviewer` — evidence-based, actionable PR review policy.

The installer links each skill into:

```text
~/.codex/skills/
~/.claude/skills/
~/.cursor/skills/
```

Edits therefore reach all three tools immediately. Run `pnpm skills:install`
after adding a new skill. Restart Claude Code or open a new Cursor chat when a
new personal skill directory is introduced. Tool-managed system/plugin skills
remain owned by their respective runtimes and are not mirrored.

The model-orchestrator skill is provider-neutral, but its example model aliases
and `[providers]` table are not a ready-made account configuration. A project
using its `mo.py` runner must define executable provider commands and real model
identifiers in that project's `.orchestrator/config.toml`.

## Configuration

| Variable                                 | Default             | Purpose                                                                         |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                           | required            | GitHub API, clone, review, comment, and push authentication.                    |
| `REPOS`                                  | required for daemon | Comma-separated `owner/repo` list.                                              |
| `AGENT`                                  | `codex`             | `codex`, `claude-code`, or `zcode`.                                             |
| `AGENT_SELF_USER`                        | unset               | Dedicated bot username to ignore; personal-token mode relies on the marker tag. |
| `POLL_INTERVAL_SEC`                      | `60`                | Poll interval; minimum 5 seconds.                                               |
| `COMMENT_BATCH_WINDOW_SEC`               | `10`                | Quiet debounce after the latest related comment.                                |
| `COMMENT_BATCH_MIN_COMMENTS`             | `2`                 | Related-comment count that makes a batch eligible.                              |
| `COMMENT_BATCH_MAX_WAIT_SEC`             | `300`               | Maximum age before a smaller batch becomes eligible; `0` disables it.           |
| `REVIEW_ADVERSARIAL_MODE`                | `auto`              | `off`, `auto`, or `always`.                                                     |
| `REVIEW_ADVERSARIAL_AGENT`               | same as `AGENT`     | Adapter for the verification pass.                                              |
| `PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN` | `false`             | Replay comments visible on the first poll.                                      |
| `STATE_DIR`                              | `./state`           | Polling state, cached repos, and worktrees.                                     |
| `KEEP_WORKDIRS`                          | `false`             | Retain worktrees for debugging.                                                 |

Retention, retry, and binary override settings are documented in
[.env.example](.env.example).

## Guardrails and current limitations

- Agents run unattended inside managed worktrees. Codex and Claude adapters use
  their explicit permission-bypass flags; only run this on a trusted machine.
- Pushes use `--force-with-lease` pinned to the fetched branch SHA, so a remote
  update causes a safe failure instead of overwriting newer work.
- Review-only mode rejects agent file changes and posts only findings that map
  to right-side lines in the GitHub diff.
- Bot output carries an invisible marker and is ignored on later polls, which
  prevents feedback loops.
- PR automation currently supports branches in the watched repository. Forked
  PR head repositories are not yet resolved or pushed.
- Execution is serial. Webhooks, concurrency, and a bundled background-service
  definition are future extensions.
- Real GitHub/model smoke tests are opt-in; normal tests use local repositories
  and fake agent binaries and spend no tokens.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm check:scripts
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test
pnpm test:smoke
pnpm test:python
pnpm run doctor
```

These are the authoritative local verification commands. `pnpm test` includes
every production TypeScript file under `src/` and fails below 100% for lines,
branches, or functions. All normal test tiers use local servers, temporary Git
repositories, and fake agent binaries, so they spend no model tokens and need no
GitHub credentials.

Pull requests run seven parallel jobs covering quality and type safety, unit
tests, integration tests, deterministic end-to-end behavior, complete coverage,
the compiled runtime, and the Python orchestrator. Pushes to `main`, manual
runs, and the weekly schedule add Linux and macOS validation plus a production
dependency audit. Windows is not a supported CI target. Keep the pull-request
jobs as required branch protection checks; the `main` workflow is a broader
post-merge safety net. `doctor` remains the machine-specific check for local
credentials, binaries, and skill links.

The extension seams are intentionally small:

1. `src/sources/` produces events.
2. `src/workflows/` handles event kinds.
3. `src/agents/` adapts coding-agent CLIs.
4. `src/runner/` prepares isolated worktrees and executes agents.
