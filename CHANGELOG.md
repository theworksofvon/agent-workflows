# Changelog

Service-level changelog for `agent-workflows`. This file is for human and agent handoff context about the daemon itself. Runtime PR-processing history is stored separately per watched repository under `state/github/<owner>/<repo>.json`.

## 2026-06-23

- Added the Codex adapter (`AGENT=codex`) using non-interactive `codex exec`.
- Added PR comment batching: inline review comments group by GitHub review id when available, otherwise by PR, with a default 120-second quiet window.
- Changed the PR workflow from one comment per run to one `comments[]` batch per run.
- Added typed per-repo GitHub state files at `state/github/<owner>/<repo>.json`.
- Bounded agent context and state retention with `PR_CONTEXT_HISTORY_LIMIT`, `COMMENT_BATCH_HISTORY_LIMIT`, and `PROCESSED_COMMENT_KEY_LIMIT`.
- Removed raw generic state from workflow context; agents only receive recent scoped changelog entries for the current PR.
- Handoff: current branch is `feature/comment-batching`; latest validation was `npm run typecheck`.

## 0.1.0

### Added

- Initial local daemon skeleton.
- GitHub PR comment polling source.
- Isolated workdir preparation and cleanup.
- Serial task queue for one agent run at a time.
- PR comment workflow that clones the PR branch, runs a coding agent, pushes produced commits, and posts a marker comment.
- ZCode and Claude Code agent adapters.
