# Changelog

## Unreleased

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
