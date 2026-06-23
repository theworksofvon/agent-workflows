# Changelog

Service-level changelog for `agent-workflows`. This file is for human and agent handoff context about the daemon itself. Runtime PR-processing history is stored separately per watched repository under `state/github/<owner>/<repo>.json`.

## Unreleased

### Added

- Added a Codex adapter (`AGENT=codex`) that runs `codex exec` non-interactively inside the isolated PR checkout.
- Added PR comment batching with a default 120-second quiet window via `COMMENT_BATCH_WINDOW_SEC`.
- Added support for grouping inline review comments by GitHub review submission when `pull_request_review_id` is available.
- Added bounded PR context history in prompts via `PR_CONTEXT_HISTORY_LIMIT`.
- Added bounded per-PR changelog retention via `COMMENT_BATCH_HISTORY_LIMIT`.
- Added bounded processed-comment key retention via `PROCESSED_COMMENT_KEY_LIMIT`.
- Added typed per-repo GitHub state files at `state/github/<owner>/<repo>.json`.

### Changed

- Changed the PR comment workflow payload from a single comment to a `comments[]` batch.
- Changed prompts so agents address all comments in a batch in one focused run.
- Moved GitHub cursor, pending batch, processed key, and PR history state out of the old flat `state.json` key pattern and into `GitHubRepoStateStore`.
- Removed raw generic state from workflow context. Workflows now read bounded, scoped GitHub history through the typed repo state store.

### Notes For Next Agent

- Current feature branch: `feature/comment-batching`.
- Latest pushed commits on this branch:
  - `ab5ea90 Use per-repo GitHub state files`
  - `d42de9f Add Codex adapter and PR comment batching`
- `npm run typecheck` passed after the per-repo state refactor.
- Do not pass raw repo state to coding agents. Only pass the latest `PR_CONTEXT_HISTORY_LIMIT` changelog entries for the current repo and PR.
- The root `CHANGELOG.md` is intentionally distinct from runtime per-repo changelog entries stored in `state/github/<owner>/<repo>.json`.

## 0.1.0

### Added

- Initial local daemon skeleton.
- GitHub PR comment polling source.
- Isolated workdir preparation and cleanup.
- Serial task queue for one agent run at a time.
- PR comment workflow that clones the PR branch, runs a coding agent, pushes produced commits, and posts a marker comment.
- ZCode and Claude Code agent adapters.
