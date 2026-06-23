# Changelog

## Unreleased

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
