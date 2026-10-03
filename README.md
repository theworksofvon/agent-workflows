# agent-workflows

Connect GitHub pull-request activity to local coding agents. Code owns every
deterministic step: intake, batching, worktrees, pushes, and what gets posted.
The agent owns every judgment call: which comments to act on, what to change,
and how to reply.

## What it offers

| Capability            | What happens                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR comment automation | Batches related feedback, runs an agent in an isolated worktree, and safely pushes resulting commits back to the PR branch.                                                        |
| Event-driven intake   | GitHub webhooks deliver comments and PR events as they happen. Polling continues every five minutes as a reconciliation pass, so either source can be off with no behavior change. |
| Per-comment decisions | The agent must write a report marking every comment `addressed`, `skipped`, or `needs_human`. Code turns that report into pushes, thread replies, and one summary comment.         |
| Manual PR review      | Runs a read-only review against any accessible PR. It prints findings by default and can post one grouped GitHub review with `--post`.                                             |
| Adversarial review    | Optionally sends the primary result through an independent verification pass for large, sensitive, or high-severity changes.                                                       |

```text
GitHub webhook ─┐
                ├─> batch gate ─> per-PR lane ─> isolated worktree ─> agent + report ─> guarded push + replies
GitHub poll ────┘                                                  ↘ review-only ─> findings/review
```

## Clean install

### Prerequisites

- Git
- [mise](https://mise.jdx.dev), which installs the pinned Node 24 and pnpm 11
  from `mise.toml`. Without mise, install those two versions yourself.
- A GitHub token
- At least one supported agent CLI: Codex, Claude Code, or ZCode
- Tailscale only when using `TAILSCALE_FUNNEL=true`

### 1. Set up the repository

```bash
git clone <repository-url>
cd agent-workflows
mise install                  # Node 24 and pnpm 11 from mise.toml
mise run setup
```

`mise run setup` installs locked dependencies, builds production JavaScript,
and creates `.env` without overwriting an existing one.

### 2. Authenticate an agent and install its skills

Choose the adapter you will put in `.env`:

```bash
codex login                   # AGENT=codex
claude auth login             # AGENT=claude-code
```

ZCode users must install and authenticate its CLI separately.

Install the `pr-feedback` and `pr-reviewer` skills from
[vstack](https://github.com/theworksofvon/vstack) into the harness you chose.
The daemon launches the agent with those skills by name and does not bundle
them.

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
Registering webhooks with `webhooks install` additionally needs
`admin:repo_hook` (classic) or Webhooks read/write (fine-grained).

### 4. Verify and run

```bash
mise run doctor
pnpm start
```

`doctor` checks the runtime, Git, `.env`, the selected agent executable and
authentication, the required skills in that agent's skill directory, and the
webhook configuration without making GitHub or model calls.

With no public URL configured the daemon polls every 300 seconds and nothing
else. See [Receiving webhooks](#receiving-webhooks) to turn on event delivery
and [Running in the background](#running-in-the-background) to keep it alive
across terminal exits and restarts.

## Common commands

| Command                                  | Purpose                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `mise run setup`                         | Install dependencies, build, and create `.env`.                                    |
| `mise run doctor`                        | Validate a machine before starting the daemon.                                     |
| `mise run build`                         | Compile TypeScript and source maps into `dist/`.                                   |
| `pnpm start`                             | Run the compiled daemon with Node.                                                 |
| `mise run dev`                           | Run with source watching.                                                          |
| `pnpm review owner/repo#123`             | Review a PR locally without posting or changing files.                             |
| `pnpm review owner/repo#123 --post`      | Post new actionable findings as one grouped review.                                |
| `pnpm agent-workflows webhooks install`  | Create or update the GitHub webhook on every repo in `REPOS`.                      |
| `pnpm agent-workflows webhooks status`   | List recent webhook deliveries and failures per repo.                              |
| `pnpm agent-workflows service install`   | Install the daemon as a launchd agent (macOS) or systemd user unit (Linux).        |
| `pnpm agent-workflows service uninstall` | Stop and remove that service definition.                                           |
| `mise run test:unit`                     | Run fast unit tests.                                                               |
| `mise run test:integration`              | Run local integration tests, including clean setup and temporary Git repositories. |
| `mise run test`                          | Run every Node test with exact 100% coverage for production TypeScript.            |
| `mise run test:smoke`                    | Exercise compiled CLI help routes without credentials or network access.           |
| `mise run lint`                          | Run ESLint across TypeScript and Node scripts.                                     |
| `mise run format:check`                  | Verify repository formatting with Prettier.                                        |

Review targets can also be full GitHub PR URLs. Use `--adversarial` or
`--no-adversarial` to override the configured review policy. See
[docs/pr-review-mode.md](docs/pr-review-mode.md).

The compiled production process remains terminal-friendly: logs stream live,
`Ctrl+C` performs graceful shutdown, and child agent/Git processes behave the
same as in development. Use `mise run dev` when automatic restart after source
edits is desired.

## Receiving webhooks

The daemon binds `HOST` (default `127.0.0.1`) and `PORT` (default `3773`).
How GitHub reaches it is one of three configurations:

| Configuration           | Behavior                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL` set        | You own the ingress (reverse proxy, Cloudflare Tunnel, anything). The daemon registers that URL with GitHub.                                      |
| `TAILSCALE_FUNNEL=true` | The daemon runs `tailscale funnel` on `PORT` at start and turns it off at stop, derives the public URL from `tailscale status`, and registers it. |
| Neither                 | Webhooks are disabled. Polling alone drives the daemon.                                                                                           |

`WEBHOOK_SECRET` is required whenever webhooks are on. Every delivery is
verified with HMAC-SHA256 against it and deduplicated on the GitHub delivery
ID. Unsigned or badly signed deliveries get a 401 and are logged without the
body.

```bash
pnpm agent-workflows webhooks install   # idempotent: an existing hook at the daemon URL is updated in place
pnpm agent-workflows webhooks status    # recent deliveries and failures for each repo
```

Consumed events: `issue_comment`, `pull_request_review_comment`,
`pull_request_review`, and `pull_request` with action `opened` or
`ready_for_review`. Events from fork head repositories and draft PRs are
dropped. When `AUTO_REVIEW=true`, newly opened or ready PRs get a posted
review automatically.

## Running in the background

```bash
mise run build
pnpm agent-workflows service install
pnpm agent-workflows service uninstall
```

`service install` writes a launchd agent on macOS or a systemd user unit on
Linux that runs the compiled daemon from the current checkout, restarts it on
failure, and writes logs under `STATE_DIR/logs/`. On Linux it also enables
lingering so the unit survives logout. On macOS a launchd agent only runs
while that user is logged in; use a login item or a dedicated always-on
machine if the daemon must run unattended.

## Token-aware comment batching

Immediate event delivery does not imply one model call per comment. Every event
source feeds the same batch gate:

1. Related comments are grouped by PR conversation or GitHub review ID.
2. A 10-second quiet period absorbs comments arriving together.
3. Two related comments make the batch eligible to run.
4. A lone comment runs after five minutes so important feedback is not ignored.

The defaults can be adjusted with `COMMENT_BATCH_WINDOW_SEC`,
`COMMENT_BATCH_MIN_COMMENTS`, and `COMMENT_BATCH_MAX_WAIT_SEC`. Webhooks remove
polling latency without bypassing this gate.

Batches for the same PR run one at a time, in arrival order. Batches for
different PRs run concurrently up to `MAX_CONCURRENT_RUNS`.

## Safe first startup and state

Runtime state lives under `STATE_DIR` (`./state` by default) and is intentionally
not committed. It contains polling cursors, pending batches, duplicate guards,
review history, cached bare repositories, managed worktrees, and service logs.

A new state directory establishes cursors on its first successful poll and
does **not** process comments that already existed. New comments are handled
normally afterward. To intentionally process existing comments, set:

```dotenv
PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN=true
```

When moving a running daemon to another machine, copy `state/github/` while the
old daemon is stopped. Cached repositories and worktrees can be recreated.
Never run two daemon instances against the same repositories and state history.

## Configuration

| Variable                                 | Default             | Purpose                                                                         |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                           | required            | GitHub API, clone, review, comment, webhook, and push authentication.           |
| `REPOS`                                  | required for daemon | Comma-separated `owner/repo` list.                                              |
| `AGENT`                                  | `codex`             | `codex`, `claude-code`, or `zcode`.                                             |
| `AGENT_SELF_USER`                        | unset               | Dedicated bot username to ignore; personal-token mode relies on the marker tag. |
| `ALLOWED_AUTHORS`                        | unset               | Comma-separated logins allowed to trigger runs. Unset means everyone.           |
| `HOST`                                   | `127.0.0.1`         | Webhook listener bind address.                                                  |
| `PORT`                                   | `3773`              | Webhook listener port.                                                          |
| `WEBHOOK_SECRET`                         | unset               | HMAC secret shared with GitHub. Required when webhooks are on.                  |
| `PUBLIC_URL`                             | unset               | URL GitHub posts to when you own the ingress.                                   |
| `TAILSCALE_FUNNEL`                       | `false`             | Expose `PORT` through Tailscale Funnel and derive the public URL.               |
| `POLL_INTERVAL_SEC`                      | `300`               | Reconciliation poll interval; minimum 5 seconds.                                |
| `MAX_CONCURRENT_RUNS`                    | `3`                 | Global cap on simultaneous agent runs.                                          |
| `AUTO_REVIEW`                            | `false`             | Review newly opened or ready PRs and post findings.                             |
| `COMMENT_BATCH_WINDOW_SEC`               | `10`                | Quiet debounce after the latest related comment.                                |
| `COMMENT_BATCH_MIN_COMMENTS`             | `2`                 | Related-comment count that makes a batch eligible.                              |
| `COMMENT_BATCH_MAX_WAIT_SEC`             | `300`               | Maximum age before a smaller batch becomes eligible; `0` disables it.           |
| `REVIEW_ADVERSARIAL_MODE`                | `auto`              | `off`, `auto`, or `always`.                                                     |
| `REVIEW_ADVERSARIAL_AGENT`               | same as `AGENT`     | Adapter for the verification pass.                                              |
| `PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN` | `false`             | Replay comments visible on the first poll.                                      |
| `STATE_DIR`                              | `./state`           | Polling state, cached repos, worktrees, and service logs.                       |
| `KEEP_WORKDIRS`                          | `false`             | Retain worktrees for debugging.                                                 |

Retention, retry, and binary override settings are documented in
[.env.example](.env.example).

## Guardrails and current limitations

- Agents run unattended inside managed worktrees. Codex and Claude adapters use
  their explicit permission-bypass flags; only run this on a trusted machine.
- Comments from authors outside `ALLOWED_AUTHORS` never reach the agent. Leave
  it unset only on private repositories.
- A missing or invalid agent report means nothing is pushed. The worktree is
  discarded and one summary comment says the batch was not applied.
- Pushes use `--force-with-lease` pinned to the fetched branch SHA, so a remote
  update causes a safe failure instead of overwriting newer work.
- Review-only mode rejects agent file changes and posts only findings that map
  to right-side lines in the GitHub diff.
- Bot output carries an invisible marker and is ignored on later polls, which
  prevents feedback loops.
- PR automation currently supports branches in the watched repository. Events
  from forked head repositories are dropped and never pushed.
- Windows is not a supported service or CI target.
- Real GitHub/model smoke tests are opt-in; normal tests use local repositories
  and fake agent binaries and spend no tokens.

## Development

```bash
mise run deps
mise run gate       # typecheck, lint, format, scripts, tests, build, smoke, in parallel
mise run doctor
```

`mise tasks` lists every command; the gate's parts (`typecheck`,
`typecheck:tests`, `lint`, `format:check`, `check:scripts`, `test`,
`test:smoke`) can be run on their own. These are the authoritative local
verification commands and CI runs the same tasks. `mise run test` includes
every production TypeScript file under `src/` and fails below 100% for lines,
branches, or functions. All test tiers use local servers, temporary Git
repositories, and fake agent binaries, so they spend no model tokens and need no
GitHub credentials.

Pull requests run five parallel jobs covering quality and type safety, unit
tests, integration tests, complete coverage, and the compiled runtime. Pushes to
`main`, manual runs, and the weekly schedule add Linux and macOS validation plus
a production dependency audit. Keep the pull-request jobs as required branch
protection checks; the `main` workflow is a broader post-merge safety net.
`doctor` remains the machine-specific check for local credentials, binaries,
and skills.

The code is laid out as ports and adapters, and the extension seams are
intentionally small:

1. `src/domain/` holds pure types and decisions: events, batching, the
   report contract, risk, and webhook normalization. No I/O.
2. `src/services/` orchestrates: intake, polling, webhook handling, dispatch
   lanes, feedback handling, and review. Services depend only on ports.
3. `src/adapters/` implements the ports: agent CLIs, Git, GitHub, the HTTP
   listener, state files, Tailscale, and service managers.
