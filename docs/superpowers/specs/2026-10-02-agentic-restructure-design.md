# Agentic restructure

Date: 2026-10-02. Status: approved design, awaiting implementation plan.

## Goal

Keep every deterministic step of the PR-automation flow in code, and hand every
judgment call to the coding agent. Restructure the repository into ports and
adapters so the seam between the two is explicit and testable. Move everything
that is a reusable capability out of this repository into vstack, and
everything that is a machine guard into dotfiles.

Make the daemon event-driven: GitHub pushes events to it, polling becomes a
slow reconciliation pass. Run batches for different PRs concurrently. Review
new PRs automatically when enabled. Make hosting a configuration choice so the
same daemon runs on a laptop, a homelab box, or someone else's server.

Non-goals: fork PR support, a GitHub App identity, Windows service support.

## Principle

| Code decides | Agent decides |
| --- | --- |
| Which comments form a batch and when it is ready | Which comments to act on, skip, or escalate, and why |
| Author allowlist and bot filtering | What a comment means and what change it implies |
| Worktree, branch, base SHA | What to inspect, edit, and run |
| Whether anything was committed and whether to push | How many commits and what goes in them |
| What is posted to GitHub and in what shape | The wording of each reply and the summary |
| Retries, cursors, marking processed | Whether a comment is answerable at all |

Inside the task the agent is unconstrained. It runs as a full harness session
in the worktree with its normal tools and the vstack skills loaded. The launch
prompt says only: here is the packet, use the `pr-feedback` skill, write the
report to this path, do not push.

## Event flow

```
GitHub --webhook POST--> adapters/http/webhook ---+
                                                  +--> domain events --> services/dispatch --> per-PR lane --> handle-feedback | review-pr
GitHub <--poll (slow)--- services/poll -----------+
```

Both sources normalize into the same domain `Comment` and `PullRequest`
shapes and pass through the same dedupe (processed comment keys), so either
can be turned off with no behaviour change. The batching gate applies to both.

Webhook events consumed: `issue_comment`, `pull_request_review_comment`,
`pull_request_review`, `pull_request` (actions `opened`, `ready_for_review`).
Deliveries are verified with HMAC-SHA256 against `WEBHOOK_SECRET` and deduped
on `X-GitHub-Delivery`. Events from fork head repositories are dropped at
normalize time. Draft PRs are dropped.

Polling runs every `POLL_INTERVAL_SEC` (default 300) as reconciliation. With
no public URL configured, webhooks are off and polling alone drives the daemon.

## Dispatch and concurrency

`services/dispatch.ts` owns one serial lane per PR and a global cap of
`MAX_CONCURRENT_RUNS` (default 3). Two batches for the same PR never run at
once; batches for different PRs do. A lane drains in arrival order. Lanes are
in memory; pending batches are already persisted by the state store, so a
restart re-derives them.

## Auto review

When `AUTO_REVIEW=true`, a `pull_request` event with action `opened` or
`ready_for_review` dispatches `review-pr` with `post: true` on that PR's lane.
Default off.

## Exposure

The daemon binds `HOST` (default `127.0.0.1`) and `PORT` (default 3773). How
GitHub reaches it is one of three configurations, none of which the core
depends on:

| Config | Behaviour |
| --- | --- |
| `PUBLIC_URL` set | Daemon registers that URL with GitHub. User owns the ingress (reverse proxy, Cloudflare Tunnel, anything). |
| `TAILSCALE_FUNNEL=true` | Daemon runs `tailscale funnel <PORT>` at start and `off` at stop, derives the public URL from `tailscale status`, and registers it. Funnel, not Serve, because GitHub is outside the tailnet. |
| Neither | Webhooks disabled. Polling only. |

`adapters/tailscale/` is the only place the Tailscale CLI is invoked. It is an
optional adapter the way t3code treats Tailscale as an endpoint provider.

## CLI

```
agent-workflows                      daemon (default)
agent-workflows review <target>      existing review mode
agent-workflows webhooks install     create or update the webhook on every repo in REPOS
agent-workflows webhooks status      list recent deliveries and failures per repo
agent-workflows service install      launchd agent (macOS) or systemd user unit (Linux)
agent-workflows service uninstall
```

`webhooks install` uses `GITHUB_TOKEN`, which therefore needs
`admin:repo_hook` (classic) or Webhooks read/write (fine-grained). It is
idempotent: an existing hook with the daemon's URL is updated in place.

## Layout

Imports point down: main, services, adapters, domain.

```
src/
  main.ts                 CLI entry. Builds the concrete adapters, calls a service.
  config.ts
  domain/
    events.ts             PullRequest, Comment, CommentBatch, ReviewTarget, WebhookDelivery
    decisions.ts          AgentReport, CommentDecision, ReviewFinding; parse + validate
    batching.ts           pure: group, quiet window, min count, max wait
    risk.ts               pure: adversarial decision
    errors.ts             DomainError and subclasses
  services/
    dispatch.ts           per-PR lanes, global cap
    poll.ts               cursors in, ready batches out; reconciliation
    webhook.ts            verify, dedupe, normalize delivery -> domain events
    handle-feedback.ts    worktree -> agent -> report -> commit/push/reply
    review-pr.ts          worktree -> agent -> findings -> post
    webhooks-admin.ts     install/status against GitHub hooks API
  adapters/
    http/                 listener; hands raw deliveries to services/webhook
    github/               github.interface.ts + octokit.ts
    git/                  git.interface.ts + exec.ts (clone, worktree, lease push)
    agent/                agent.interface.ts + claude-code.ts, codex.ts, zcode.ts
    state/                state.interface.ts + json-file.ts
    tailscale/            tailscale.interface.ts + cli.ts (funnel on/off, status)
    service/              launchd.ts, systemd.ts
tests/
  unit/                   domain and services against fakes
  integration/            temp git repos, fake agent binary, local HTTP GitHub, webhook POSTs
```

Each `adapters/<role>/` folder holds its interface beside its implementations.
Services are typed only against interfaces. `main.ts` is the one place that
names a concrete implementation. `skills/` is deleted from this repository.

## Contract

Code writes a packet into the run directory inside the worktree:

```json
{
  "repo": "owner/name", "prNumber": 12, "title": "...", "body": "...",
  "headRef": "...", "baseRef": "...", "baseSha": "...",
  "comments": [
    { "key": "owner/name#12:review:991", "author": "...", "kind": "review",
      "path": "src/x.ts", "line": 40, "diffHunk": "...", "body": "..." }
  ],
  "history": [ { "handledAt": "...", "summary": "..." } ],
  "reportPath": ".agent-workflows/report.json"
}
```

The agent writes the report. It is mandatory.

```json
{
  "summary": "one paragraph for the PR comment",
  "comments": [
    { "key": "...", "decision": "addressed", "note": "optional" },
    { "key": "...", "decision": "skipped", "reason": "already handled in abc123" },
    { "key": "...", "decision": "needs_human", "reason": "conflicts with the stated design" }
  ]
}
```

Validation: every comment key in the packet appears exactly once; decision is
one of the three values; `reason` is required for `skipped` and `needs_human`.
Keys the agent omits are recorded as `needs_human` with reason "no decision
reported".

Review mode uses the same mechanism. The agent writes the existing findings
JSON to `reportPath` instead of stdout.

## Deterministic tail

After the agent exits, code does, in order:

1. Read and validate the report.
2. Commit uncommitted changes with a fallback message.
3. If commits are ahead of the fetched base SHA, push with `--force-with-lease`
   pinned to that SHA.
4. Reply on each `skipped` and `needs_human` thread with the agent's reason,
   tagged with the marker.
5. Post one marker summary comment: the agent's summary, commit count, and
   per-decision counts.
6. Record history and mark every comment in the batch processed.

The flow is built to run unattended. The only outputs a human sees are the
summary comment and the per-thread replies.

## Failure policy

Designed so the daemon keeps flowing and nobody is paged.

| Situation | Action |
| --- | --- |
| Agent exits nonzero with a rate-limit signature | Pause batch, retry after `AGENT_RETRY_DELAY_SEC`, up to `AGENT_MAX_ATTEMPTS`. Unchanged. |
| Agent exits but no report | Relaunch once in the same worktree with the prompt "your report at <path> is missing; write it now, change nothing else". |
| Still no report, or report invalid | Discard the worktree. No push. Post one summary: "agent produced no report; batch not applied". Mark processed so the batch does not loop. |
| Report valid, commits exist | Push and post. |
| Report valid, no commits, all decisions `skipped` or `needs_human` | No push. Post replies and summary. |
| Push rejected by lease | Post summary "branch moved during run; changes discarded". Mark processed. |

`needs_human` is a label on a reply, not a stop. The daemon moves on. A later
comment on that thread is just a new comment.

## Trust surface

Deterministic policy, applied in both `services/poll.ts` and `services/webhook.ts`:

- `ALLOWED_AUTHORS`: comma-separated GitHub logins. When set, comments from
  anyone else are skipped at poll time and never reach the agent. Unset means
  everyone, which is the current behaviour and is only safe on private repos.
- Existing bot and marker filtering stays.
- Webhook deliveries without a valid signature are rejected with 401 and logged
  without the body.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listener bind address. |
| `PORT` | `3773` | Listener port. |
| `WEBHOOK_SECRET` | unset | HMAC secret shared with GitHub. Required when webhooks are on. |
| `PUBLIC_URL` | unset | URL GitHub posts to when the user owns ingress. |
| `TAILSCALE_FUNNEL` | `false` | Expose `PORT` through Tailscale Funnel and derive the URL. |
| `POLL_INTERVAL_SEC` | `300` | Reconciliation interval. Was 60. |
| `MAX_CONCURRENT_RUNS` | `3` | Global cap on simultaneous agent runs. |
| `AUTO_REVIEW` | `false` | Review newly opened or ready PRs and post findings. |
| `ALLOWED_AUTHORS` | unset | Comma-separated logins allowed to trigger runs. |

## What moves where

| Thing | From | To |
| --- | --- | --- |
| Prompt prose in `src/workflows/pr-comment/context.ts` | this repo | vstack `skills/pr-feedback/SKILL.md` (new) |
| `skills/pr-reviewer` | this repo | deleted; vstack copy is identical and already linked |
| `skills/model-orchestrator` | this repo | deleted; vstack copy is newer. Review it separately. |
| `dotfiles/agents/skills/model-orchestrator` | dotfiles | deleted; third copy |
| `scripts/install-shared-skills.*`, skill checks in `doctor.mjs` | this repo | deleted; vstack and `skill-forge` own linking |
| Permission-bypass flags in agent adapters | this repo | stay. They are launch arguments, not guards. Guards are dotfiles hooks and already apply to any session on this machine. |

The `pr-feedback` skill carries: the role, the evidence standard for deciding
addressed vs skipped vs needs_human, the instruction to run the repository's
own validation before committing, and the report schema. It does not carry
anything about pushing, batching, or GitHub.

## Testing

- `domain/`: pure unit tests, including batching windows and report
  validation edge cases (missing keys, duplicate keys, bad decision values).
- `services/`: unit tests against in-memory fakes of every port. Cover each
  row of the failure table.
- `adapters/`: integration tests with temporary git repositories and a fake
  agent binary that writes a scripted report. Local HTTP server for GitHub.
- Coverage gate stays at 100 percent for `src/`.

## Testing additions

- `services/webhook.ts`: signature accept and reject, delivery dedupe, each
  event type normalizes to the expected domain event, fork and draft drops.
- `services/dispatch.ts`: same-PR serial, cross-PR parallel up to the cap,
  drain order.
- `adapters/http`: integration test POSTs signed payloads at a real listener.
- `adapters/tailscale`: unit tests against a fake CLI; never invoked in CI.
- `webhooks install`: integration test against the local fake GitHub server
  for create and update paths.

## Migration order

1. Create `domain/` and `adapters/*/interface.ts` and move existing code into
   the new layout with behaviour unchanged. Tests green.
2. Add `ALLOWED_AUTHORS` to poll.
3. Add report writing to the fake agent, report parsing to `domain/decisions.ts`,
   and the deterministic tail to `handle-feedback.ts`. Replace prompt prose
   with the three-line launch prompt.
4. Add `services/dispatch.ts` and route poll output through it.
5. Add `services/webhook.ts` and `adapters/http`. Wire into dispatch. Drop
   poll default to 300.
6. Add `AUTO_REVIEW` routing for `pull_request` events.
7. Add `adapters/tailscale`, `PUBLIC_URL`, `webhooks install|status`.
8. Add `service install|uninstall`.
9. Write `pr-feedback` skill in vstack (commit on `main`, do not push).
10. Delete `skills/`, skill installer, and doctor skill checks here. Delete the
    dotfiles copy on `agents/hooks-dir`.
11. Update README and CHANGELOG.
12. Before restarting the daemon: move `state/github/EK-LABS-LLC/pluto-predicts.json`
    aside so cursors re-establish, and trim `REPOS` or set `ALLOWED_AUTHORS`
    for the public repositories.

## Follow-ups, out of scope here

- Review and update vstack `model-orchestrator`: the profiles config is new and
  untested against real CLIs; `provider-adapters.md` names model IDs that drift.
- Review mode could adopt the same per-finding decision shape for adversarial
  passes.
- GitHub App identity so bot output is not attributed to a personal account.
