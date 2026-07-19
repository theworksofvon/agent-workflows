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

Force or suppress the independent adversarial pass for one run:

```bash
npm run review -- owner/repo#123 --adversarial
npm run review -- owner/repo#123 --no-adversarial
```

## What It Does

- Fetches the PR title, body, branch info, and changed files.
- Creates an isolated worktree for the PR branch.
- Runs the configured `AGENT` (`zcode`, `claude-code`, `codex`, etc.).
- Embeds the repo-local `skills/pr-reviewer` contract for consistent behavior across adapters.
- In `auto` mode, runs a fresh adversarial reviewer for large or sensitive diffs and high-severity primary findings.
- Asks for actionable review findings only.
- Prints findings locally by default.
- With `--post`, submits one GitHub review with inline comments.

## Guardrails

- Never commits or pushes.
- Refuses to run on draft PRs.
- Refuses to post if the agent edits files.
- Refuses to post if the agent exits nonzero.
- Refuses to post if the agent output is not valid review JSON.
- Skips duplicate findings already posted for the same PR.
- Skips findings whose path or line cannot be attached to the PR diff.

## Cost and reviewer configuration

`REVIEW_ADVERSARIAL_MODE` accepts `off`, `auto` (default), or `always`. `auto` adds a second call only when deterministic risk signals justify it: at least 12 files, at least 400 changed lines, sensitive paths, missing API patches, or a critical/high primary finding.

`REVIEW_ADVERSARIAL_AGENT` selects the adapter for that pass and defaults to `AGENT`. A different provider gives stronger independence; the same provider still runs in a fresh process and context.

`REPOS` is only required for daemon polling. Review mode can target any PR your `GITHUB_TOKEN` can access.
