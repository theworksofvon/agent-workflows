# Changelog

## Unreleased

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
