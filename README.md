# agent-workflows

A local app for reviewing GitHub pull requests yourself, with coding agents
doing the reading first. Agents split a PR into chapters and find problems.
You give each finding a verdict, add your own comments, and publish one
GitHub review after a preview. Nothing posts without your confirmation.

The repository also has a one-shot `review` command that runs the same agent
review from the terminal and can post the findings.

## What it offers

| Capability         | What happens                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox              | Lists the open PRs that request your review, that you wrote, or that involve you, for the GitHub account you choose, with CI checks per PR.               |
| Accounts           | Acts as any account that `gh` has logged in. Each review fetches, clones, checks, and publishes as the account that started it.                           |
| Triage             | Decides which PRs need a deep review, with rules over the PR metadata.                                                                                    |
| Guided review      | A guide agent splits the diff into chapters, ordered core-first. A review agent writes findings inline on the lines they concern, in a separate worktree. |
| Adversarial review | An independent agent checks the primary review for large, sensitive, or high-severity changes, or when triage asks for a deep review.                     |
| Verdicts           | You mark each finding agree, disagree, or unsure, with a reason, mark chapters and files as reviewed, and add your own comments.                          |
| Publish            | One combined GitHub review, pinned to the commit that the agents read. It lists the agent findings you rejected, with your reasons.                       |
| `review` command   | A read-only review of any PR that your token can read. It prints findings by default, and `--post` posts the new ones as one grouped review.              |

```text
inbox ─> triage ─> guide agent  ─┐
                   review agent ─┼─> your verdicts and comments ─> preview ─> one GitHub review
                   adversarial  ─┘
```

## Install

### Prerequisites

- Git
- [mise](https://mise.jdx.dev), which installs the pinned Node 24 and pnpm 11
  from `mise.toml`. Without mise, install those two versions yourself.
- [`gh`](https://cli.github.com), logged in to each GitHub account you want
  the app to act as, or a GitHub token in `GITHUB_TOKEN`. Without a gh
  account, the app acts as the account of `GITHUB_TOKEN`.
- At least one supported agent CLI: Codex or Claude Code

To run the app in Docker instead, see [Run with Docker](#run-with-docker).

### 1. Set up the repository

```bash
git clone <repository-url>
cd agent-workflows
mise install                  # Node 24 and pnpm 11 from mise.toml
mise run setup                # install, build, and create .env
mise run web:build            # build the web app into web/dist
```

`mise run setup` does not overwrite an existing `.env`. Run
`mise run web:build` again after you change `web/`.

### 2. Authenticate an agent and install its skill

Choose the adapter you will put in `.env`:

```bash
codex login                   # AGENT=codex
claude auth login             # AGENT=claude-code
```

Install the `pr-reviewer` skill from
[vstack](https://github.com/theworksofvon/vstack) into the harness you chose.
The app launches the review agents with that skill by name and does not
bundle it.

### 3. Configure GitHub

Log in each account that the app can act as with `gh auth login`;
`gh auth status` must list it for github.com. Then edit `.env`. The minimum
configuration is:

```dotenv
AGENT=codex
```

`GITHUB_TOKEN` is optional when gh has an account. When it is set, the
`review` command uses it, and the app uses its account only when gh has no
account. Without it, `review` acts as gh's active account. The token must be
able to read PRs, clone the repository, and create reviews. For a
fine-grained token this normally means repository Contents read and Pull
requests read/write access.

### 4. Verify and run

```bash
mise run doctor
pnpm start
```

`doctor` checks the runtime, Git, `.env`, the selected agent executable and
authentication, and the `pr-reviewer` skill in that agent's skill directory.
It makes no GitHub or model calls.

`pnpm start` serves the app and its API at http://127.0.0.1:4773 until you
press `Ctrl+C`. Logs stream to the terminal, and `Ctrl+C` or `SIGTERM` shuts
down in order: the app stops taking requests, a publish in flight finishes,
running reviews get 15 seconds, and reviews still running after that are
marked interrupted before the database closes.

## Run with Docker

The image holds the app, the web app, Git, `gh`, Claude Code, and Codex.
`compose.yaml` publishes the app on `127.0.0.1` only and keeps its state and
logins in named volumes, so they stay when you rebuild or remove the
container. You need Docker with Compose, such as OrbStack or Docker Desktop.

| Volume          | Mounted at                 | Holds                                       |
| --------------- | -------------------------- | ------------------------------------------- |
| `state`         | `/var/lib/agent-workflows` | The database, cached repos, and worktrees.  |
| `gh-config`     | `/home/node/.config/gh`    | The accounts from `gh auth login`.          |
| `claude-config` | `/home/node/.claude`       | Claude Code's settings and session history. |
| `codex-home`    | `/home/node/.codex`        | The Codex login and settings.               |

### One-time setup

1. Create the environment file. Git ignores `docker.env`.

   ```bash
   cp docker.env.example docker.env
   ```

2. For Claude Code, run `claude setup-token` on the host. Put the token that
   it prints in `docker.env` as `CLAUDE_CODE_OAUTH_TOKEN`, and keep
   `AGENT=claude-code`. The token uses your Claude subscription.
3. Build the image and log in to GitHub. gh prints a code and a URL; open the
   URL on the host. Run the command again for each account. The login stays
   in the `gh-config` volume.

   ```bash
   docker compose build
   docker compose run --rm app gh auth login --hostname github.com --git-protocol https --web
   ```

   gh does not log in while `GITHUB_TOKEN` is set. If `docker.env` sets it,
   add `-e GITHUB_TOKEN=` after `run`.

4. Optional, for Codex: log in with a device code, and set `AGENT=codex` or
   `REVIEW_ADVERSARIAL_AGENT=codex` in `docker.env`. The login stays in the
   `codex-home` volume.

   ```bash
   docker compose run --rm app codex login --device-auth
   ```

5. Give the agents the `pr-reviewer` skill. Compose mounts `SKILLS_DIR`
   read-only as the skill directory of Claude Code and of Codex. The default
   is `../vstack/skills`, a vstack clone beside this repository. Set
   `SKILLS_DIR` to another directory that holds `pr-reviewer/SKILL.md` if
   your clone is somewhere else. Do not use `~/.claude/skills` when its
   entries are symlinks, because the links do not resolve in the container.
6. Check the container:

   ```bash
   docker compose run --rm app node scripts/doctor.mjs
   ```

The container does not share your host's gh, Claude Code, or Codex logins.
On macOS, gh keeps its tokens in the Keychain, so a mounted `~/.config/gh`
has no tokens. A shared Codex login would let 2 machines refresh the same
token, and `~/.codex` also holds host settings, hooks, and paths.

### Daily use

```bash
docker compose up -d          # or: mise run docker:up
docker compose logs -f app
docker compose down
```

The app is at http://127.0.0.1:4773. To use another host port, set
`HOST_PORT`, for example `HOST_PORT=4793 docker compose up -d`; compose
gives the same port to the app as `UI_PUBLIC_PORT`, so its Host and Origin
checks accept it. Inside the container the app listens on `0.0.0.0`, so it
logs a warning that `UI_HOST` is not a loopback address; the published port
stays on `127.0.0.1`. After `git pull`, run `docker compose build` (or
`mise run docker:build`) and `docker compose up -d`. The agent CLI versions
are build arguments in the `Dockerfile` (`CLAUDE_CODE_VERSION`,
`CODEX_VERSION`).

To run the `review` command in the container:

```bash
docker compose run --rm app node dist/main.js review owner/repo#123
```

## Commands

```text
pnpm start
pnpm review owner/repo#123 [--post|--dry-run] [--adversarial|--no-adversarial]
pnpm agent-workflows open owner/repo#123
```

| Command                                    | Purpose                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm start`                               | Serve the guided review app and API. `start` is the default; `ui` is an alias. |
| `pnpm review owner/repo#123`               | Review a PR locally without posting or changing files.                         |
| `pnpm review owner/repo#123 --post`        | Post the new findings as one grouped review.                                   |
| `pnpm review owner/repo#123 --adversarial` | Force the adversarial pass; `--no-adversarial` skips it.                       |
| `pnpm agent-workflows open owner/repo#123` | Start a guided review in the running app and open it in its T3 thread.         |
| `mise run start`                           | Build, then serve the app (alias `ui`).                                        |
| `mise run dev`                             | Run from source and restart on change.                                         |
| `mise run web:dev`                         | Run the web app with hot reload against the app on port 4773.                  |

Review targets can also be full GitHub PR URLs. See
[docs/pr-review-mode.md](docs/pr-review-mode.md) for the `review` command.

## Guided review

The overview ranks the open PRs in your inbox. A review splits the diff into
chapters, ordered core-first, with agent findings inline on the lines they
concern. You mark each finding agree, disagree, or unsure, with a reason, and
add your own comments. Publishing shows a preview first and then posts one
combined GitHub review.

- The review pins the head commit that the agents read, so its lines match
  that commit.
- Re-run starts a new session for the same PR. Your verdicts, marks, and
  comments carry over; a verdict applies again when the same finding returns.
- The guide writer and the reviewer read separate worktrees; the adversarial
  reviewer reuses the reviewer's worktree. Fork PRs are refused.
- Agents run through the configured `AGENT` CLI, so they use your
  subscription and not an API key.

### Discuss a review in T3 Code

Each review can open in its own [T3 Code](https://github.com/pingdotgg/t3code)
thread, with the review page in T3's preview pane beside the chat. The chat
and the page share context:

- When the agent records a verdict or a comment, the page shows it at once.
- The agent knows what you have open: the tab, the finding, the file, and the
  lines that you selected. "Why is this risky?" needs no file name.
- Select lines in a diff, or use **Ask** on a finding, to send a question
  about them to the thread.

The thread belongs to 1 GitHub account's review of 1 PR. Its title is
`Review: owner/repo#123 as <account>`, and every message names the account.
A re-run of the PR goes to the same thread. The same PR reviewed as another
account gets its own thread. When T3 has a project for the PR's repository,
the thread opens in that project; otherwise it is a scratch thread.

Connect T3 once:

1. In T3, open **Settings → Connections**, open the environment's menu, and
   choose **Copy MCP URL**. Set it as `T3_MCP_URL` in `.env`, or paste it in
   the app when you click **Open in T3**.
2. Click **Open in T3**, then **Connect**. T3 asks you to approve the sign-in;
   choose **Supervised** or a broader mode. Read-only access cannot open
   threads.

The sign-in lasts 30 days, and T3 issues no refresh token, so connect again
after it ends. The app keeps the token in its database and never shows or
logs it. Without T3, **Copy prompt instead** copies a prompt for any agent.

The agent in the thread uses the app's MCP server and the `guided-review`
skill. Register the server once for each agent CLI:

```bash
claude mcp add --scope user --transport http guided-review http://127.0.0.1:4773/mcp
codex mcp add guided-review --url http://127.0.0.1:4773/mcp
```

| Tool                              | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `get_review`                      | The PR, its account, the guide, the findings, and your state. |
| `get_focus`                       | What you have open in the app now.                            |
| `set_verdict`, `add_comment`      | Record your verdict on a finding, or your comment on a line.  |
| `delete_comment`, `mark_reviewed` | Remove your comment, or mark a chapter or file reviewed.      |

No tool publishes. You publish from the app.

T3 actions run a saved command in a T3 terminal. 2 are useful here; add them
in T3's project or environment settings:

| Action           | Command                                                      |
| ---------------- | ------------------------------------------------------------ |
| Start review app | `mise run start` in this checkout, or `docker compose up -d` |
| Review PR        | `read -r "pr?PR: " && pnpm agent-workflows open "$pr"`       |

In Docker, the app reaches a T3 on the host at `host.docker.internal`, so set
`T3_MCP_URL=http://host.docker.internal:3773/mcp`.

### Triage

Triage decides how much review a PR needs, with rules over the PR metadata.
It uses no model.

- `skip` when only generated files, lockfiles, or documentation changed.
- `deep` for a sensitive path (such as auth, payments, or migrations), 25 or
  more files, or 800 or more changed lines.
- `standard` for 6 or more files or 150 or more changed lines.
- `light` for every other change.

A `deep` triage runs the adversarial pass, even when
`REVIEW_ADVERSARIAL_MODE` is `off`.

## State

Runtime state lives under `STATE_DIR` (`./state` by default) and is not
committed. It holds the SQLite database `agent-workflows.sqlite` (guided
review sessions, your verdicts, marks, and comments, the current account, and
the findings that `review --post` already posted), cached bare repositories,
and managed worktrees.

- At start and once a day, the app deletes finished sessions past the newest
  5 of a PR, or older than 30 days. A PR's newest session stays, and so does
  a session with verdicts, marks, or comments that was never published. Each
  edit counts as activity for the 30 days.
- To move the app to another machine, stop it, then copy
  `state/agent-workflows.sqlite` together with its `-wal` and `-shm` files.
  Cached repositories and worktrees can be recreated.
- A `review` run and the app can share one state directory. They wait on each
  other's database and repository locks.

## Configuration

| Variable                   | Default                       | Purpose                                                                        |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`             | optional                      | Token for `review` and for the app when `gh` has no account.                   |
| `AGENT`                    | `codex`                       | `codex` or `claude-code`.                                                      |
| `REVIEW_ADVERSARIAL_MODE`  | `auto`                        | `off`, `auto`, or `always`. A deep triage runs the pass even when it is `off`. |
| `REVIEW_ADVERSARIAL_AGENT` | same as `AGENT`               | Adapter for the adversarial pass.                                              |
| `UI_HOST`                  | `127.0.0.1`                   | Address the app listens on.                                                    |
| `UI_PORT`                  | `4773`                        | Port the app listens on. T3 Code uses 3773.                                    |
| `UI_PUBLIC_PORT`           | `UI_PORT`                     | Port in the browser's address, when Docker publishes another port.             |
| `MAX_CONCURRENT_RUNS`      | `3`                           | Agent processes that run at the same time. A guided run counts as 2.           |
| `STATE_DIR`                | `./state`                     | Database, cached repositories, and worktrees.                                  |
| `KEEP_WORKDIRS`            | `false`                       | Keep worktrees and run directories for debugging.                              |
| `CODEX_BIN`                | `codex`                       | Codex executable.                                                              |
| `CLAUDE_CODE_BIN`          | `claude`                      | Claude Code executable.                                                        |
| `LOG_LEVEL`                | `info`                        | `debug`, `info`, `warn`, or `error`.                                           |
| `T3_MCP_URL`               | unset                         | T3 Code's MCP URL, until you enter another in the app.                         |
| `T3_MODEL`                 | `claudeAgent/claude-opus-5-5` | The model of each review thread, as `<provider instance>/<model>`.             |

The variables of the removed feedback bot (`REPOS`, `POLL_INTERVAL_SEC`,
`HOST`, `PORT`, `WEBHOOK_SECRET`, `PUBLIC_URL`, `TAILSCALE_FUNNEL`,
`AUTO_REVIEW`, and others) are no longer read. Startup warns when one is
still set; remove it from `.env`. The same holds for `DECISION_ENGINE`,
`DECISION_ENGINE_URL`, `DECISION_MODEL`, and `DECISION_TIMEOUT_MS`, which
selected the removed triage model.

## Guardrails and limits

- The app has no login. Anyone who can reach `UI_HOST:UI_PORT` can publish
  reviews as your accounts, so it warns when `UI_HOST` is not a loopback
  address. It accepts only its own Host and Origin and only JSON writes.
- Agents run in managed worktrees with the Codex and Claude Code
  permission-bypass flags. Run the app only on a trusted machine.
- The agents only read. A run that changes files, exits nonzero, or does not
  write a valid report after one relaunch fails, and nothing from it is
  posted.
- `review --post` skips findings that it already posted to the same PR and
  findings whose lines are not in the GitHub diff.
- Runs past `MAX_CONCURRENT_RUNS` wait with status `queued`. With
  `MAX_CONCURRENT_RUNS=1`, the guide writer and the reviewer of one guided
  run take turns.
- A guided review refuses fork PRs. The `review` command refuses draft PRs.
- Windows is not a supported platform or CI target.

## Development

```bash
mise run deps
mise run gate       # typecheck, lint, format, scripts, tests, smoke, web app, in parallel
```

`mise tasks` lists every command; the parts of the gate (`typecheck`,
`typecheck:tests`, `lint`, `format:check`, `check:scripts`, `test`,
`test:smoke`, `web:check`) can run on their own, and CI runs the same tasks.
`mise run test` starts the real app as a separate process and tests it
through its HTTP API and the `review` command. Only the edges are fake: a
local GitHub server (REST and GraphQL) backed by real bare Git repositories,
a fake `gh`, and a fake agent CLI that reads the real checkout and writes
its report. The fakes live in `tests/integration/harness/`. The tests spend
no model tokens, need no GitHub credentials, and never post to GitHub. The
task fails below 90% of the lines and functions or 65% of the branches in
`src/`.

The code is laid out as ports and adapters:

1. `src/domain/` holds pure types and decisions: the review result contract,
   the guide, triage, risk, the inbox, and how a review is published. No I/O.
2. `src/services/` orchestrates: guided runs, the review API, GitHub access
   per account, the run dispatcher, and the `review` command. Services depend
   only on ports.
3. `src/adapters/` implements the ports: agent CLIs, Git, GitHub and `gh`,
   the HTTP server, and SQLite state.
