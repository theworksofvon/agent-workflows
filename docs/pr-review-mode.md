# PR Review Mode

Run the configured agent as a reviewer for one pull request without changing code.

Dry-run first:

```bash
npm run review -- owner/repo#123
```

Post one grouped GitHub review:

```bash
npm run review -- owner/repo#123 --post
```

GitHub PR URLs work too:

```bash
npm run review -- https://github.com/owner/repo/pull/123
```

## What It Does

- Fetches the PR title, body, branch info, and changed files.
- Creates an isolated worktree for the PR branch.
- Runs the configured `AGENT` (`zcode`, `claude-code`, `codex`, etc.).
- Asks for actionable review findings only.
- Prints findings locally by default.
- With `--post`, submits one GitHub review with inline comments.

## Guardrails

- Never commits or pushes.
- Refuses to post if the agent edits files.
- Refuses to post if the agent exits nonzero.
- Refuses to post if the agent output is not valid review JSON.
- Skips duplicate findings already posted for the same PR.

`REPOS` is only required for daemon polling. Review mode can target any PR your `GITHUB_TOKEN` can access.
