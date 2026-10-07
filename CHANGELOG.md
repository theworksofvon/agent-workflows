# Changelog

## Unreleased

### Test the Real App Through Its API

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `guided-review`.
Task: Replace the unit tests and the web mock with integration tests that drive the real app.
Message: The tests now start the real app and call its HTTP API and the `review` command. Only GitHub, `gh`, and the agent CLI are fake.
Added/Changed: `tests/integration/harness/` holds a fake GitHub server (REST and GraphQL) backed by real bare Git repositories, a fake `gh` that lists accounts from `FAKE_GH_ACCOUNTS`, and a fake agent CLI that reads the real checkout with Git and writes the guide or review report. The app clones from the fake through a `url.insteadOf` rule in a temporary HOME. 20 tests cover a guided review from creation to publish, a rerun that keeps verdicts, an agent with no report, input errors, accounts, the inbox, checks, the Host, Origin, and content-type checks, the web page, shutdown, and the `review` command with `--post`, `--adversarial`, and `GITHUB_TOKEN`. A new setting, `GITHUB_API_URL` (default `https://api.github.com`), points the app at another GitHub API. The coverage floor is now 90% of lines and functions and 65% of branches, from the coverage of the app processes that the tests start.
Fixed/Removed: `start` printed its address before it installed its SIGINT and SIGTERM handlers, so a signal in that gap stopped the app without a clean shutdown; it now prints the address last. Removed `tests/unit/` (18 files), `tests/fakes/`, the 4 integration tests that called internal functions, the 12 web test files and Vitest, the `test:unit` and `test:integration` tasks and CI jobs, and the web dev mock (`web/src/dev/`, `MOCK_API=1`).
Handoff: `mise run web:dev` needs the app running on port 4773.

### Prepare the Repository for Sharing

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Remove personal data and stale design documents before the branch goes to the public repository.
Message: The web dev mock and the tests use generic accounts and repositories, and the old plans, specs, and research screenshots are gone.
Added/Changed: The dev mock, the GitHub accounts test, and the review target test use `octocat`, `octo-work`, `acme`, and `acme-labs` in place of real accounts, organizations, and repositories.
Fixed/Removed: Removed `docs/superpowers/` (the restructure and guided review plans and specs, which describe the removed daemon, webhooks, and Tailscale exposure) and `docs/guided-review/research/` (screenshots of a third-party product).
Handoff: None.

### Open a Review in T3

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Make the move from a guided review to a T3 thread easy to find and easy to continue.
Message: "Discuss in T3" is now "Open in T3". Its copied prompt names the `guided-review` skill, the app's address, and the session, so the T3 thread can load the review and record the verdicts and comments that you give it.
Added/Changed: The button keeps its label until the window is narrower than 900 px; before, it showed only an icon below 1320 px. The copied prompt starts with `Use the guided-review skill. App: <address> · session: <id>`, followed by the old prompt, which still works without the skill. The `guided-review` skill lives in the vstack skills repo. It reads the session from the app's API, checks out the PR at the reviewed commit, answers questions, and writes a verdict, comment, or reviewed mark only when you tell it to and after you confirm the request body. It never publishes; you publish from the app.
Fixed/Removed: The web dev mock no longer shows Clef stages or Clef triages.
Handoff: Run vstack's `install.sh` on each machine to link the skill. In Docker, the skill reaches the app at the address in the prompt, so keep `HOST_PORT` the same as the address that you open.

### Remove Clef

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Remove the Clef decision engine, because not everyone can run the model locally.
Message: Triage now uses only the rules over the PR metadata. The Clef sidecar, the SystemOne engine adapter, and their settings are gone.
Added/Changed: A guided run triages with the heuristic: `skip`, `light`, `standard`, or `deep` from the file count, the diff size, and sensitive paths, with engine `heuristic`. A `deep` triage still runs the adversarial pass, even when `REVIEW_ADVERSARIAL_MODE` is `off`. Sessions that an older version stored with a Clef triage (engine `systemone:clef-flash`, a confidence, and probabilities) still load, and the web app still shows their triage badge. `GET /api/health` returns `ok` and `agent` and no longer returns `engine`.
Fixed/Removed: Removed `sidecars/clef/`, the `clef` mise task, `src/adapters/decision/` (the decision engine port and the SystemOne HTTP adapter), and the SystemOne question and answer code in triage. `DECISION_ENGINE`, `DECISION_ENGINE_URL`, `DECISION_MODEL`, and `DECISION_TIMEOUT_MS` are no longer read; startup warns when one is still set, and an invalid value no longer stops startup.
Handoff: Remove the `DECISION_*` variables from `.env` and `.env.example`; this change did not edit `.env.example`. Stop the Clef sidecar if it runs. The model cache stays on disk, usually at `~/.cache/huggingface/hub/models--Cloudflare--clef-flash` (about 19 GB). Check that path and that nothing else uses it, then delete it by hand. Rebuild with `mise run build` and `mise run web:build`, and restart `start`.

### Run with Docker

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Let the user run the whole app with Docker on a laptop.
Message: `docker compose up -d` serves the guided review app at http://127.0.0.1:4773 from one image with Git, `gh`, Claude Code, and Codex, and `GITHUB_TOKEN` is no longer required when gh has an account.
Added/Changed: A multi-stage `Dockerfile` (Node 24 slim, `gh` from GitHub's apt repository, Claude Code 2.1.292 and Codex 0.160.1 as build arguments, the built backend and web app, the `node` user, and a health check), `compose.yaml`, `.dockerignore`, and `docker.env.example`. Compose publishes only on `127.0.0.1:${HOST_PORT:-4773}`, keeps the state, gh, Claude Code, and Codex logins in the named volumes `state`, `gh-config`, `claude-config`, and `codex-home`, and mounts `SKILLS_DIR` (default `../vstack/skills`) read-only as the skill directory of both agents. `UI_PUBLIC_PORT` (default `UI_PORT`) names the port in the browser's address; the Host and Origin checks accept it for the listen address, `127.0.0.1`, and `localhost` only. `GITHUB_TOKEN` is optional: without it, the app uses only gh's accounts, `review` acts as gh's active account, and gh with no account fails with the fix. `doctor` reads the environment as well as `.env`, lists gh's github.com accounts, accepts them in place of `GITHUB_TOKEN`, skips the `.env` and `pnpm` checks in the image, and finds skills in `~/.agents/skills`, `$CODEX_HOME/skills`, and `$CLAUDE_CONFIG_DIR/skills`. New mise tasks `docker:build` and `docker:up`.
Fixed/Removed: None.
Handoff: Copy `docker.env.example` to `docker.env` and set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Run `docker compose build`, then `docker compose run --rm app gh auth login --hostname github.com --git-protocol https --web` for each account, and `docker compose run --rm app codex login --device-auth` for Codex. Stop a host `start` before `docker compose up -d`, or set `HOST_PORT`, because both use port 4773. This change did not edit `.env.example`; check its `GITHUB_TOKEN` line by hand.

### Sidebar Views and Compact Footer

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Make the guided review app's sidebar easier to scan and remove the controls that looked out of place.
Message: The sidebar has one header row, a list of views, one PR list grouped by repo, and a footer row with the account and a small theme control.
Added/Changed: The header holds the brand and a small "+" button that opens the New review form. A vertical list of views (Review requested, Created by me, Involved, Guided reviews) with counts replaces the 3 inbox tabs and the separate Reviews section; the selected view is saved. A count shows "–" until its data loads. An "All repos" chip filters the list when a view has more than 1 repo. Rows are grouped by repo with a count, and a row no longer repeats its repo name. The footer holds the account switcher, whose menu opens upward, and a 3-icon theme control (System, Light, Dark). A click on the repo in a page's breadcrumb switches to a view that shows that repo.
Fixed/Removed: Removed the full-width "New review" button, the labeled theme bar, and the inbox's segmented tabs. Counts no longer read 0 while the inbox loads.
Handoff: Rebuild with `mise run web:build`; the server serves the new build on the next page load.

### Remove the Feedback Bot

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Make the repository one small local app: the guided review web app and the one-shot `review` command.
Message: The PR feedback bot is gone. `start` now serves only the guided review app and API, and nothing polls GitHub, receives webhooks, batches comments, pushes commits, or posts reviews on its own.
Added/Changed: `start` (also the default command) serves the guided review app on `UI_HOST:UI_PORT`, as `ui` did; `ui` is an alias of `start`, and `mise run start` (alias `ui`) replaces `mise run ui`. An unknown command is an error; before, it started the daemon. If the app cannot bind `UI_PORT`, `start` fails and closes the database. Shutdown closes the app, waits for a publish in flight, gives guided runs 15 seconds, then marks the runs still going as interrupted and closes the database. `review` and its options are unchanged. `doctor` checks only the `pr-reviewer` skill and no longer checks `REPOS` or the webhook settings. The guided review HTTP API and `web/` are unchanged.
Fixed/Removed: Removed the `webhooks install|status` and `service install|uninstall` commands, the polling loop, the webhook listener, comment batching, the PR feedback agent runs and pushes, `AUTO_REVIEW`, Tailscale Funnel support, and the launchd and systemd service files they wrote. `REPOS`, `POLL_INTERVAL_SEC`, `COMMENT_BATCH_WINDOW_SEC`, `AGENT_MAX_ATTEMPTS`, `PROCESS_EXISTING_COMMENTS_ON_FIRST_RUN`, `AGENT_SELF_USER`, `ALLOWED_AUTHORS`, `HOST`, `PORT`, `WEBHOOK_SECRET`, `PUBLIC_URL`, `TAILSCALE_FUNNEL`, and `AUTO_REVIEW` are no longer read; startup warns when one is still set. `UI_PORT` no longer has to differ from `PORT`. Opening the database drops the bot's tables (`repos`, `pr_cursors`, `comment_groups`, `processed_comments`, `seen_deliveries`, `pr_batch_history`); posted review findings, guided review sessions, verdicts, marks, comments, and settings are kept. The `pr-feedback` skill is no longer needed.
Handoff: Remove the retired variables from `.env`. If you installed the service, remove it by hand. On macOS, run `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.theworksofvon.agent-workflows.plist` and delete that file. On Linux, run `systemctl --user disable --now agent-workflows.service` and delete `~/.config/systemd/user/agent-workflows.service`. Delete the GitHub webhooks that `webhooks install` created, and turn off Tailscale Funnel if you used it. Rebuild with `mise run build` and restart `start`.

### Review Fixes for Tokens, Accounts, and Shutdown

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Fix the findings of the code review of the guided review, accounts, inbox, and one-service work.
Message: A GitHub token no longer appears in git errors, logs, session errors, or the repo cache's config; the publishing account never changes silently; unpublished review work is never pruned; and `start` shuts down without losing a publish or a run's state.
Added/Changed: Security: git gets the token as an `Authorization` header for `https://github.com/` through `GIT_CONFIG_COUNT` environment variables, never in a URL or argv; clone, fetch, and push use clean `https://github.com/<owner>/<repo>` URLs; git errors and debug logs redact URL credentials and token-shaped strings; `start` and `ui` rewrite cached repos' origin URLs that an older version stored with a token. `PUT /api/sessions/:id/account` with `{ "login" }` records the account of a session stored without one (once; another login is a 409); publish and re-run of such a session answer 409 "choose the account for this review" until then, and `POST /api/sessions/:id/rerun` takes an optional `account` for it. `GET /api/accounts` lists each account with `ok` (false when gh reports its login invalid; it stays selectable, and using it fails with the fix). `GET /api/inbox` adds `truncated` (per group, when GitHub matched more than 50), `warnings` (errors GitHub returned beside partial results, such as an SSO-protected org), and `stale` (true when a rate limit served the last inbox; refreshes wait 60 seconds); each search sorts by `updated-desc`. Checks read up to 500 contexts in pages of 100 and add `truncated`; past that, GitHub's own rollup still counts in `rollup`. A guided run counts as 2 of `MAX_CONCURRENT_RUNS`, and with 1 its guide writer and reviewer take turns. The Clef sidecar answers 503 "model loading" after `CLEF_LOAD_WAIT_SEC` (default 45) seconds of a load, and retries a failed load 60 seconds after the failure. `UI_PORT` equal to `PORT` is a startup error; `AGENT=zcode` or `REVIEW_ADVERSARIAL_AGENT=zcode` fails with a message that ZCode support was removed; startup warns about the retired variables that are still set.
Fixed/Removed: A gh error or timeout no longer switches the accounts to the `GITHUB_TOKEN` account: only a missing gh or no gh account does, and other errors keep the last list or fail clearly. An empty `gh auth token` is an error and is not cached. Sessions stored without an account get one at startup only from a real gh account. A finished session with verdicts, marks, or comments that was never published is not pruned, and each such edit updates the session's `updatedAt`. When `start` cannot bind `UI_PORT`, the daemon keeps running; `ui` closes the database when it cannot start. Shutdown closes the app first, waits for a publish in flight, drains runs, then marks guided runs still going as interrupted before the database closes; such a run stops without writing. Note the earlier changes: `DECISION_TIMEOUT_MS` now defaults to 60000 (was 30000), and the dropped `pr_review_runs` table does not come back when you run an older version.
Handoff: Rebuild with `mise run build`, restart `start` or `ui`, and restart the Clef sidecar. Check `state/repos/*/*.git/config` once for credentials; the next `start` or `ui` rewrites them.

### GitHub Accounts, PR Inbox, and CI Checks

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Let the guided review app act as any GitHub account that `gh` has logged in, list the PRs that need you, and show CI checks.
Message: The app reads accounts from `gh auth status`, keeps the current one across restarts, shows an inbox of PRs that request your review, that you wrote, or that involve you, and reports CI checks per PR; each guided review fetches, clones, checks, and publishes as the account that started it.
Added/Changed: `GET /api/accounts` and `PUT /api/accounts/current` (an unknown login is a 400); the current account is stored in a new `settings` table (`ui.account`) and defaults to gh's active account. Tokens come from `gh auth token --user` on demand, stay in memory for 5 minutes, and never reach the browser or the log; `gh` runs without `GH_TOKEN` and `GITHUB_TOKEN`, so the token in `.env` does not hide the keyring accounts; without `gh` or a gh account, the account that `GITHUB_TOKEN` belongs to stands in. `GET /api/inbox` runs 3 GraphQL searches (review requested, authored, involved; 50 each) as the current account, merges them by PR with `groups` and the latest `sessionId`, and caches for 60 seconds per account (`?refresh=1` skips the cache); additions, deletions, and changed files come in the same query. `GET /api/sessions/:id/checks` and `GET /api/repos/:owner/:repo/pulls/:number/checks` return the head commit's checks, deduped to the newest run per workflow and name, with T3 Code's status mapping and rollup, cached for 20 seconds. `GET /api/repos/:owner/:repo/pulls/:number` returns a PR with its body for the preview. `GET /api/repos/:owner/:repo/pulls` now returns inbox rows. `POST /api/sessions` takes an optional `account`. Sessions record `account`; the PR snapshot records the author avatar, state, and last commit; a session summary adds `account`, `authorAvatarUrl`, `state`, `reviewedChapters`, and `createdAt`. A guided run fetches the PR through GraphQL. The daemon still uses `GITHUB_TOKEN`.
Fixed/Removed: The sidebar count of reviewed chapters now comes from the server. Sessions stored before this change read as state `open` with no avatar or last commit, and get the current account recorded on them when `start` or `ui` starts.
Handoff: Log in each account with `gh auth login`; `gh auth status` must list it for github.com. Rebuild with `mise run build` and restart `start` or `ui`.

### Run as One Service on a Laptop

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Cut code and memory the system does not need on a laptop or small home box, and run the daemon and the guided review app as one service.
Message: `start` (and the installed service) now runs the daemon and the guided review app in one process, old guided review sessions are pruned, and the Clef sidecar frees its 20 GB of memory when idle.
Added/Changed: `start` serves the guided review app on `UI_HOST:UI_PORT` beside the daemon, with one SQLite connection, one GitHub client, and one `MAX_CONCURRENT_RUNS` cap for comment batches, automatic reviews, and guided runs; the webhook listener stays on `HOST:PORT`, so Funnel never exposes the app; shutdown stops both; `ui` still serves the app alone. `start` and `ui` delete finished guided review sessions past the newest 5 of a PR or older than 30 days, never a PR's newest, at startup and once a day. The Clef sidecar unloads the model after `CLEF_IDLE_UNLOAD_SEC` (default 900) idle seconds, reports `"state": "unloaded"` in `/health`, and loads it again on the next request, which waits instead of getting 503. `DECISION_TIMEOUT_MS` defaults to 60000. An agent run keeps only the last 64 KB of each output stream. The guided adversarial pass reuses the review worktree, so a deep review prepares 2 checkouts, not 3. Report files in a guided run are `primary-report.json` and `adversarial-report.json`. A second SIGINT or SIGTERM during shutdown is ignored.
Fixed/Removed: Removed the ZCode adapter and `ZCODE_BIN`. `PR_CONTEXT_HISTORY_LIMIT`, `COMMENT_BATCH_HISTORY_LIMIT`, `PROCESSED_COMMENT_KEY_LIMIT`, `COMMENT_BATCH_MIN_COMMENTS`, `COMMENT_BATCH_MAX_WAIT_SEC`, and `AGENT_RETRY_DELAY_SEC` are no longer read; their old defaults are fixed. The write-only `pr_review_runs` table is dropped when the database opens; posted review findings are kept. Internally, the three agent adapters, the two HTTP servers' listen and body code, the two primary-then-adversarial review flows, and duplicated helpers each became one.
Handoff: Remove `ZCODE_BIN` and the six retired variables from `.env` and `.env.example`; they are ignored. Stop a separate `ui` process before `start`, because both bind `UI_PORT`. Restart the Clef sidecar to pick up idle unloading.

### Guided Review

Date: 2026-10-07 CDT; Status: Completed; PR: none yet on `feat/guided-review`.
Task: Let a person review a PR with agents doing the reading first, and publish only what the person confirms.
Message: `agent-workflows ui` serves a local web app and API that triage PRs, split a PR into chapters with agent findings inline, record your verdicts and comments, and post one combined GitHub review after a preview.
Added/Changed: `ui` command and API (`UI_HOST`, `UI_PORT` default 4773); SQLite tables for sessions and human review state; a guide prompt that produces chapters; triage through a SystemOne decision engine with a heuristic fallback (`DECISION_ENGINE`, `DECISION_ENGINE_URL`, `DECISION_MODEL`, `DECISION_TIMEOUT_MS`); the Clef sidecar in `sidecars/clef`; the web app in `web/`; `mise run ui`, `clef`, `web:dev`, `web:build`, and `web:check`, with `web:check` in `gate`. `prepareWorkdir` now fetches the base branch, and so does `reviewPullRequest`. The review prompt names the diff ref when patches are omitted. `listOpenPRs` returns the author. A guided run pins the PR's head commit: each worktree checks out the snapshot `headSha` (`prepareWorkdir` takes `commit` and fetches it by SHA when the branch moved), and publish sends it as `commit_id` (`createPullRequestReview` takes `commitId`). The guide writer, the reviewer, and the adversarial reviewer each get their own worktree. The web app follows T3 Code's look: a sidebar of sessions grouped by repo with search (⌘K) and a new-review form, a 52px top bar with a breadcrumb (repo, PR, tab, chapter, current file), tabs, progress, and actions, a System/Light/Dark theme (with dual Shiki themes), a chapter stepper on the guide, and a "Back to Overview" pill after a jump from the overview; it uses `lucide-react` icons. Re-run is allowed only for a ready or failed session, asks first, and carries verdicts (by finding id), chapter and file marks, and comments to the new session. Runs queue behind `MAX_CONCURRENT_RUNS` with status `queued`. A lock directory beside the bare repo cache serializes its fetches and worktree changes across processes. CI runs `web:check`.
Fixed/Removed: Security: the API refuses a foreign Host or Origin and any write that is not JSON, and static files are confined to `web/dist`; `ui` warns when `UI_HOST` is not a loopback address. A fork PR fails its session with a clear error. An agent chapter with the id `other` moves to a free `other-N` id. An interrupted session shows the stage `Interrupted`. The publish dialog no longer offers a second post. A file diff collapsed at 400 lines says how many findings and comments it hides.
Handoff: Run `mise run web:build` before `mise run ui`. To use Clef, set `DECISION_ENGINE=systemone` and run `mise run clef`; the first run downloads about 19 GB.

### Store State in SQLite

Date: 2026-10-03 CDT; Status: Completed; PR: #7 on `feat/agentic-restructure`.
Task: Stop rewriting one whole JSON file per repository on every state change.
Message: Daemon state now lives in one SQLite database, `state/agent-workflows.sqlite`, through Node's built-in `node:sqlite`; each change commits atomically, so a crash never leaves half an update.
Added/Changed: Cursors, pending and in-flight batches, processed comment keys, seen webhook deliveries, batch and review history, and posted review findings are rows keyed by repository; the database runs in WAL mode and waits up to 5 seconds for a lock held by another process. `sqliteState(config, { recoverInFlight: true })` restores batches a previous process left in flight; only the daemon sets it, so a `review` run beside a live daemon no longer requeues its running batch. Batching, retry, restore, and retention behaviour is unchanged.
Fixed/Removed: Removed the per-repository JSON state store and its legacy-file normalization and corrupt-file reset.
Handoff: Existing `state/github/*.json` files are not migrated; the daemon starts from an empty database and re-establishes cursors on its first poll. To move a daemon, stop it and copy `state/agent-workflows.sqlite` with its `-wal` and `-shm` files.

### Move Developer Commands to mise

Date: 2026-10-03 CDT; Status: Completed; PR: #7 on `feat/agentic-restructure`.
Task: Make mise the single place that defines the toolchain, the shell environment, and every developer command, instead of splitting them across `.nvmrc`, corepack, and `package.json` scripts.
Message: `mise install` provides Node 24 and pnpm 11, `mise run gate` runs every check CI runs with independent tasks in parallel, and `.env` is loaded into the shell inside the repo.
Added/Changed: `mise.toml` with tools, `[env]`, and tasks (`deps`, `setup`, `doctor`, `build`, `dev`, `typecheck`, `typecheck:tests`, `lint`, `format`, `format:check`, `check:scripts`, `test`, `test:unit`, `test:integration`, `test:smoke`, `gate`); both workflows install the toolchain with `jdx/mise-action` and call the same tasks; `package.json` scripts reduced to `start`, `review`, and `agent-workflows`; the webhook listener now re-checks a repo's pending batches once the quiet window has passed instead of waiting for the next poll.
Fixed/Removed: Removed `.nvmrc`, the corepack install steps, and the pnpm and Node setup actions from CI; `test:typecheck` is now `typecheck:tests`.
Handoff: Run `mise install` once in an existing checkout. The daemon under launchd or systemd still reads `.env` itself because no shell is involved there.

### Keep Batches Across Failures and Restarts

Date: 2026-10-03 CDT; Status: Completed; PR: #7 on `feat/agentic-restructure`.
Task: Close the whole-branch review findings where comment batches could be lost or a missed webhook could never be reconciled.
Message: A taken batch now stays on disk as in-flight until it completes or pauses, so a crash, restart, or thrown error puts it back in the queue instead of dropping it.
Added/Changed: In-flight batch record restored on load; any thrown error in feedback handling pauses the batch for retry or, at max attempts, posts a failure summary and marks it processed; `stop()` waits up to 15 seconds for running lanes; a paused batch merges comments that arrived during the run; only the poller moves comment cursors; a delivery is marked seen only after its PR lookup succeeds.
Fixed/Removed: Fork pull requests are now skipped on the poll path as well as the webhook path. Removed the cursor advance from intake.
Handoff: Existing `state/github/*.json` files were moved to `state/.archive/github-2026-10-03/`; delete that folder once the daemon has run cleanly.

### Agentic, Event-Driven Restructure

Date: 2026-10-02 CDT; Status: Completed; PR: #7 on `feat/agentic-restructure`.
Task: Keep every deterministic step in code and hand every judgment call to the agent, with GitHub webhooks as the primary event source.
Message: The daemon is now ports and adapters; the agent receives a packet, decides per comment, and must write a report that code turns into pushes, thread replies, and a summary.
Added/Changed: `domain/`, `services/`, `adapters/` layout; mandatory agent report with per-comment `addressed`, `skipped`, `needs_human`; webhook listener with HMAC verification and delivery dedupe; polling demoted to 300-second reconciliation; per-PR dispatch lanes with `MAX_CONCURRENT_RUNS`; `AUTO_REVIEW`; `ALLOWED_AUTHORS`; `PUBLIC_URL` and `TAILSCALE_FUNNEL` exposure; `webhooks install|status`; `service install|uninstall`.
Fixed/Removed: Removed bundled `skills/`, the skill installer, doctor skill-link checks, and the Python test job; the `pr-feedback` skill lives in vstack. A missing report no longer lets uncommitted agent work be pushed.
Handoff: Before restarting against existing state, move `state/github/EK-LABS-LLC/pluto-predicts.json` aside so cursors re-establish, and set `ALLOWED_AUTHORS` or trim `REPOS` for public repositories.

### Narrow Supported CI Platforms

Date: 2026-07-19 CDT; Status: Completed; PR: Pending on `agent/drop-windows-ci`.
Task: Align the post-merge matrix with the operating systems this project intends to support.
Message: Main-branch validation now targets Linux and macOS; Windows is explicitly outside the supported CI surface.
Added/Changed: Simplified Python test execution to use `python3` directly and documented the supported CI platforms.
Fixed/Removed: Removed the Windows matrix runner, the Windows-only Python launcher shim, and Windows-specific setup-test environment handling after the first post-merge run showed those paths require platform-specific command execution the project does not need.
Handoff: Verify the full deterministic suite on Linux or macOS and confirm the next main-branch workflow passes both supported platform jobs, quality gates, and the production dependency audit.

### Expand CI Validation Tiers

Date: 2026-07-19 CDT; Status: Completed; PR: Pending on `feat/pr-review-skill-adversarial`.
Task: Make pull-request validation comprehensive while keeping broader platform and dependency checks separate after merge.
Message: Pull requests now run parallel quality, unit, integration, deterministic end-to-end, coverage, compiled-runtime, and Python checks; `main` adds Linux, macOS, and Windows validation plus scheduled production dependency audits.
Added/Changed: Added ESLint and Prettier gates, Actionlint and ShellCheck validation, a clean-install setup test, a local HTTP/Git end-to-end workflow test, cross-platform Python discovery, seven focused PR jobs, and a three-platform main-branch matrix. The Node suite now contains 60 deterministic no-token tests and continues to require exact 100% line, branch, and function coverage for production TypeScript.
Fixed/Removed: Preserved wrapped error causes, made GitHub API endpoints injectable for boundary testing, and removed the assumption that `python3` is the Python executable on every supported platform.
Handoff: Verified locally with production and test typechecks, build, lint, formatting, script checks, all Node test tiers, compiled smoke tests, five Python tests, production dependency audit, ShellCheck, Actionlint, and diff validation; GitHub-hosted platform checks remain to run after the branch is pushed.

### Adopt pnpm As Package Manager

Date: 2026-07-19 CDT; Status: Completed; PR: Pending on `feat/pr-review-skill-adversarial`.
Task: Migrate repository installation, development, testing, and CI workflows from npm to pnpm.
Message: Clean installs and contributor commands now use a pinned pnpm 11 release and a pnpm-native lockfile.
Added/Changed: Added `pnpm@11.15.0` package-manager metadata, `pnpm-lock.yaml`, an explicit dependency-build allowlist, Corepack bootstrap instructions, pnpm-aware setup and doctor scripts, pnpm CI setup and caching, and pnpm CLI examples throughout current documentation.
Fixed/Removed: Removed `package-lock.json` and current npm command assumptions so local machines and GitHub Actions resolve dependencies through the same package manager; replaced the deprecated pnpm 11.12 CI installer path with the latest pnpm release; disambiguated repository setup and doctor scripts from pnpm's built-in commands.
Handoff: Verify with `pnpm install --frozen-lockfile`, then run the authoritative pnpm typecheck, build, script, Node, smoke, and Python test commands.

### Enforce Complete Runtime Coverage

Date: 2026-07-18 CDT; Status: Completed; PR: Pending on `feat/pr-review-skill-adversarial`.
Task: Turn the baseline test suite into comprehensive, coverage-gated CI without calling live GitHub or model services.
Message: GitHub Actions now enforces strict source and test typechecking, a compiled CLI smoke test, Python orchestrator tests, and exact 100% line, branch, and function coverage for executable production TypeScript.
Added/Changed: Expanded the Node suite from 24 to 58 tests across configuration, queues, persistence, daemon lifecycle, CLI routing, GitHub normalization, comment workflows, review workflows, adapters, and real temporary Git worktrees; added narrow typed injection seams and cross-platform path checks.
Fixed/Removed: Prevents duplicate daemon timer chains after stop/restart, rejects unsafe managed-worktree paths on POSIX and Windows path flavors, removes coverage-only runtime constants, and replaces unsafe fake-Octokit casts with a structural API contract.
Handoff: Verified with production and test typechecks, the production build, script checks, exact coverage thresholds, compiled CLI smoke tests, five Python tests, doctor, diff validation, and independent post-repair review.

### Gate Comment Runs And Compile Production

Date: 2026-07-18 CDT; Status: Completed; PR: Pending on `feat/pr-review-skill-adversarial`.
Task: Keep immediate event delivery from creating one model run per comment and remove runtime TypeScript transpilation from production.
Message: Comment groups now wait for a configurable count threshold or maximum age, and production runs compiled JavaScript under Node while development retains `tsx` watch mode.
Added/Changed: Added two-comment/five-minute batch defaults, a 10-second quiet debounce, `npm run build`, source maps, setup/doctor build integration, and CI production-build validation.
Fixed/Removed: Prevents bursty review feedback from causing one agent run per comment without leaving a lone comment pending forever; removes `tsx` from the production execution path.
Handoff: Verify with the no-token test suite, `npm run build`, `npm run doctor`, and a compiled CLI startup smoke test.

### Make Clean Installation Reproducible

Date: 2026-07-18 CDT; Status: Completed; PR: Pending on `feat/pr-review-skill-adversarial`.
Task: Turn machine-local setup assumptions into a documented, verifiable clean-install flow.
Message: A new machine can install dependencies and shared skills with `npm run setup`, validate local requirements with `npm run doctor`, and start without replaying existing PR comments.
Added/Changed: Pinned Node 24/npm 11, added cross-platform setup/doctor/skill installers, made Codex the explicit default, added safe first-poll cursor initialization, and rewrote the README around capabilities and clean installation.
Fixed/Removed: Unknown adapters now fail instead of silently falling back to missing ZCode; existing comments are skipped on a new state directory unless explicitly enabled.
Handoff: Verified with setup/doctor checks, TypeScript typechecking, the no-token test suite, and model-orchestrator Python tests.

### Document Current Runtime Behavior

Date: 2026-07-05 18:07:00 CDT; Status: In Progress; PR: Pending on `codex/docs-current-behavior`.
Task: Bring README docs in line with merged review, draft, cursor, and CI behavior.
Message: Docs now call out baseline GitHub Actions checks, draft PR skipping, per-PR cursor behavior, and review posting guardrails.
Added/Changed: Updated README testing/comment-batching sections and PR review mode guardrails.
Fixed/Removed: Reduces handoff ambiguity for review-only mode and daemon polling behavior.
Handoff: Docs-only; no code behavior changed.

### Add GitHub Actions CI

Date: 2026-07-05 13:36:00 CDT; Status: In Progress; PR: Pending on `codex/ci-checks`.
Task: Add baseline CI for this service.
Message: Pull requests and pushes to main now run dependency install, typecheck, and the no-token test suite.
Added/Changed: Added `.github/workflows/ci.yml` with Node 24, npm cache, `npm ci`, `npm run typecheck`, and `npm test`.
Fixed/Removed: No external GitHub or LLM calls are required for CI.
Handoff: Local equivalent is `npm ci && npm run typecheck && npm test`; real PR E2E should stay opt-in.

### Validate Review Findings Before Posting

Date: 2026-07-05 13:15:00 CDT; Status: In Progress; PR: Pending on `codex/pr-review-workflow`.
Task: Prevent one invalid inline finding from failing an entire posted PR review.
Message: Review mode now posts only findings whose path and right-side line exist in the PR diff.
Added/Changed: Added diff-line validation, skip logging, CLI skip counts, and regression tests for invalid findings.
Fixed/Removed: Avoids GitHub `Path could not be resolved` review submission failures.
Handoff: Verified with `npm test`, `npm run typecheck`, and a live `--post` run on `EK-LABS-LLC/pluto-predicts#2`.

### Track Comment Cursors Per PR

Date: 2026-07-05 10:03:30 CDT; Status: In Progress; PR: Pending on `codex/pr-review-workflow`.
Task: Prevent one PR's comment activity from hiding comments on another PR.
Message: Comment cursors now live under each PR state entry instead of being shared at repo level.
Added/Changed: Polling reads/writes PR-scoped issue and review cursors, with migration inference from prior batch history.
Fixed/Removed: Ready-for-review PRs can pick up comments created while they were draft, even if another PR advanced later comment IDs.
Handoff: Verified with `npm test` and `npm run typecheck`; existing processed keys still protect recently handled comments.

### Add Manual PR Review Mode

Date: 2026-07-04 20:44:00 CDT; Status: In Progress; PR: Pending on `codex/pr-review-workflow`.
Task: Let the configured agent review a specific PR without making code changes.
Message: `npm run review -- owner/repo#123` now dry-runs actionable findings, with `--post` submitting one grouped GitHub review.
Added/Changed: Added PR review target parsing, read-only review prompts, JSON finding parsing, duplicate suppression, and review state.
Fixed/Removed: Keeps review-only runs from committing, pushing, or reposting the same finding.
Handoff: Verify with `npm test` and `npm run typecheck`; review mode uses the configured `AGENT`, not a Codex-only path.

### Pause Retryable Agent Failures

Date: 2026-07-03 12:56:58 CDT; Status: In Progress; PR: Pending on `feature/comment-batching`.
Task: Keep usage/rate-limit failures retryable instead of marking comments processed.
Message: Retryable agent failures now pause batches with retry timing and preserve them for a later attempt.
Added/Changed: Added retry config, stderr-tail logging, delayed batch retry state, and completion-only processed marking.
Fixed/Removed: Prevents failed Codex usage-limit runs from permanently consuming review comments.
Handoff: Local-only; run `npm test` and `npm run typecheck`, then inspect paused batches in per-repo state.

### Process Only Inline Bot Review Comments

Date: 2026-06-29 14:49:47 CDT; Status: In Progress; PR: Pending on `feature/comment-batching`.
Task: Avoid spending agent runs on bot-authored top-level status comments.
Message: Bot conversation comments are ignored, but bot inline review comments remain actionable.
Added/Changed: Simplified poller filtering and strengthened prompt validation requirements.
Fixed/Removed: Prevents CodeRabbit follow-up/status comments from spawning no-op agents.
Handoff: Local-only; run `npm test` and `npm run typecheck` before commit.

### Use Explicit Push Leases For Worktree Branches

Date: 2026-06-29 14:23:34 CDT; Status: In Progress; PR: Pending on `feature/comment-batching`.
Task: Keep unique local worktree branches while making pushes safe and deterministic.
Message: Worktree handles now record the remote branch base SHA and push with an explicit `--force-with-lease`.
Added/Changed: Updated branch push logic and local git tests for successful pushes plus stale-remote rejection.
Fixed/Removed: Avoids ambiguous stale tracking refs while preserving concurrent worktree isolation.
Handoff: Local-only; run `npm test` and `npm run typecheck`, then retry PR #11.

### Add No-Token Agent Adapter Tests

Date: 2026-06-28 15:23:00 CDT; Status: In Progress; PR: Pending on `feature/comment-batching`.
Task: Add a cheap test flow for model-facing adapters without real LLM calls.
Message: Agent adapters now run against fake local binaries that capture argv, cwd, and stdin.
Added/Changed: Added `tests/agent-adapters.test.ts` and documented no-token testing in README.
Fixed/Removed: Avoids spending tokens for normal adapter/orchestration validation.
Handoff: Local-only; run `npm test` and `npm run typecheck` before commit.

### Use Git Worktrees For Agent Sessions

Date: 2026-06-28 14:48:56 CDT; Status: Completed; PR: Pending on `feature/comment-batching`.
Task: Replace fresh per-task clones with cached repos and isolated git worktrees.
Message: Agent sessions now run in managed worktrees under `STATE_DIR/worktrees`, backed by cached bare repos under `STATE_DIR/repos`.
Added/Changed: Added worktree guardrails, cached mirror fetches, orchestrator fallback commits, and local git-based tests.
Fixed/Removed: Removes repeated full clone setup from the task path, avoids mirror-push refspec failures, and avoids dropping intended uncommitted changes.
Handoff: Verified with `npm test` and `npm run typecheck`; no real GitHub or LLM calls are required for this coverage.

### Make AGENT_SELF_USER Optional For Personal-Token Mode

Date: 2026-06-23 16:51:59 CDT; Status: Completed; PR: Pending on `feature/comment-batching`.
Task: Let the daemon run under a personal token shared with the human reviewer.
Message: `AGENT_SELF_USER` is now optional; when unset, the marker tag (`<!-- agent-workflows:bot -->`) is the sole loop guard, so comments from the daemon's own account still trigger it.
Added/Changed: `config.agentSelfUser` is now `string | null` (loaded as optional); `isSelf` in `src/github/poller.ts` skips the username check when it is unset.
Fixed/Removed: Removed the hard requirement on `AGENT_SELF_USER`; updated `.env.example` and README to document personal-token vs dedicated-bot modes.
Handoff: Verified with `npm run typecheck`. When set, `AGENT_SELF_USER` still ignores all comments from that account regardless of marker.

### Clarify Review Agent Prompt

Date: 2026-06-23 16:05:46 CDT; Status: Completed; PR: Pending on `feature/comment-batching`.
Task: Make the coding agent prompt clearer for batched PR review feedback.
Message: Agents now receive explicit review-agent framing, repo-convention guidance, validation expectations, and delegation guidance.
Added/Changed: Updated `src/workflows/pr-comment/context.ts` instructions for batching, sub-agent use, scoped edits, and commit discipline.
Fixed/Removed: Reduces generic prompt behavior and discourages unrelated refactors or duplicate investigation.
Handoff: Verified with `npm run typecheck`; keep prompt context bounded to the current PR batch plus recent changelog.

### Add Codex Adapter And Batched PR Comment Handling

Date: 2026-06-23 15:41:30 CDT; Status: Completed; PR: Pending on `feature/comment-batching`.
Task: Add Codex support and process related GitHub PR comments as one agent run.
Message: PR comments now batch for a 120-second quiet window; inline review comments group by GitHub review id when available.
Added/Changed: Added `AGENT=codex`, `comments[]` workflow payloads, bounded prompt history, and per-repo state files at `state/github/<owner>/<repo>.json`.
Fixed/Removed: Removed raw generic state from workflow context; duplicate protection and changelog retention are bounded by config.
Handoff: Latest validation passed with `npm run typecheck`; branch is pushed as `feature/comment-batching`.

### Initial Service Skeleton

Date: 2026-06-20 22:00:00 CDT; Status: Completed; PR: None.
Task: Create the initial local daemon for routing GitHub PR comments to coding agents.
Message: The daemon polls configured repos, clones PR branches into isolated workdirs, runs an agent, pushes commits, and posts marker comments.
Added/Changed: Added GitHub polling, serial queueing, workdir management, PR-comment workflow, and ZCode/Claude Code adapters.
Fixed/Removed: N/A.
Handoff: Initial commit is `ba62a52`.
