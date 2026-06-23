# Changelog

## Unreleased

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
