# Review Threads in T3 Code

Date: 2026-10-07
Status: draft, waiting for review

## Goal

Discuss a guided review in a T3 Code thread while the review page shows
beside the chat. The chat and the page share context in both directions:

- The chat changes the page. When the agent records a verdict or a comment,
  the page shows it at once.
- The page gives context to the chat. The agent knows what the user has open,
  and an **Ask** button sends a question about the open lines or finding.

Each pull request gets exactly 1 T3 thread. When the user opens the same PR
again, T3 shows the same thread. A different PR gets a different thread.

T3 Code is not forked or patched. The design uses only T3's public surfaces:
its outside-agent MCP endpoint, its preview pane, and project actions.

## Non-goals

- No publish from chat. Publishing to GitHub stays a button that the user
  clicks in the review app.
- No deep link that brings T3 to the front at a thread. T3 has no such link
  today; the page shows the thread's link instead.
- No MCP App (an interactive page inside the thread). T3 renders MCP Apps only
  for Codex threads today.
- No chat UI inside the review app.

## Parts

| Part               | What it is                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Review MCP server  | An MCP endpoint on the review app, at `/mcp`. Any agent can use it, in T3 or not.          |
| Focus              | The review page reports what the user has open. The agent reads it with `get_focus`.       |
| Live page          | The page updates when an agent changes the review.                                         |
| T3 connection      | The review app signs in to T3's MCP endpoint 1 time, with OAuth.                           |
| Review threads     | The review app maps each PR to 1 T3 thread, and creates the thread when it is missing.     |
| Ask                | A button that sends the open lines or finding to the PR's thread as a message.             |
| CLI and T3 actions | `agent-workflows open <pr>`, and 2 suggested T3 actions that run the app and that command. |
| Skill              | The `guided-review` skill in vstack uses the MCP tools instead of `curl`.                  |

### Review MCP server

The app serves MCP over Streamable HTTP at `http://127.0.0.1:4773/mcp`, with
`@modelcontextprotocol/sdk`. The endpoint has the same Host check as the API.
MCP clients do not send an Origin header; when a request has an Origin, it must
be the app's own origin.

Tools:

| Tool             | Input                                                                                    | Result                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `get_review`     | `review` (session id)                                                                    | The PR, the guide, the findings, and the human state, as `GET /api/sessions/:id` returns them |
| `get_focus`      | none                                                                                     | What the user has open now (see Focus), or null                                               |
| `set_verdict`    | `review`, `finding`, `verdict` (`agree`, `disagree`, `unsure`, or null to clear), `note` | The human state                                                                               |
| `add_comment`    | `review`, `path`, `line`, `body`                                                         | The human state                                                                               |
| `delete_comment` | `review`, `comment`                                                                      | The human state                                                                               |
| `mark_reviewed`  | `review`, `chapter` or `path`, `reviewed`                                                | The human state                                                                               |

Each write tool calls the same service method as the matching API route, so the
rules are the same. Read tools are marked read-only in their annotations.
There is no publish tool.

### Focus

The page sends `PUT /api/focus` when the user changes what they look at, at most
once each 500 ms:

```json
{
  "review": "<session id>",
  "tab": "overview | guide | diff",
  "chapter": "<chapter id> | null",
  "finding": "<finding id> | null",
  "path": "src/api.ts | null",
  "lines": { "start": 38, "end": 45 } | null
}
```

`lines` comes from a selection in the diff or from a flow step's highlight.
The server keeps the last focus in memory, with the time it was set. A restart
clears it. `get_focus` returns it with the session's PR name, so the agent can
check that the focus is on the review that it discusses.

### Live page

The server keeps a change counter for each session. A write from the API or
from MCP increments it. `GET /api/sessions/:id/events` is a server-sent events
stream (a long HTTP response where the server sends a line for each change).
The session page listens and loads the human state again on each event. The
current poll stays as the fallback when the stream closes.

### T3 connection

The connection uses T3's outside-agent sign-in (`docs/user/outside-agents.md`
in T3 Code). It has no username, no password, and no secret in `.env`.

1. The user pastes T3's MCP URL in the review app, from T3's
   **Settings → Connections → Copy MCP URL**. `T3_MCP_URL` in `.env` can set it
   instead; the URL is not a secret.
2. The app reads T3's OAuth metadata and registers itself as a client
   (dynamic client registration), with the redirect URI
   `http://127.0.0.1:<port>/api/t3/callback`. T3 accepts `http` redirects only
   on localhost.
3. The app opens T3's sign-in page with a PKCE challenge. The user approves,
   with a pairing code if the browser is not already signed in to T3, and
   chooses **Supervised** or a broader mode.
4. T3 sends the browser back to the callback. The app exchanges the code for a
   token and stores it in the app's SQLite database.

Facts from the T3 source that the design depends on:

- T3 supports only the `authorization_code` grant with PKCE `S256`. It issues
  no refresh token.
- The token lasts 30 days (`MCP_CLIENT_SESSION_TTL` in `EnvironmentAuth.ts`).
- A **Read only** token cannot launch or message threads.

When T3 answers 401, the app deletes the token and the page shows
**Connect T3** again. **Disconnect** deletes the token. The app never logs the
token or returns it from the API.

Docker: the container reaches a T3 on the host at `host.docker.internal`, so
`T3_MCP_URL` must use that host name there. The redirect URI still uses
`127.0.0.1`, because the browser opens it.

### Review threads

The key is the GitHub account and the PR (`account:owner/repo#number`), not
the session. A rerun of the same PR as the same account reuses the thread, and
the app tells the thread about the newest session. A review of the same PR as
another account gets its own thread, because the verdicts and the published
review belong to that account.

Table `t3_threads`: `thread_key` (primary key), `thread_id`, `link`,
`project_id` (null for a scratch thread), `session_id` (the last session that
the thread saw), `created_at`.

#### The account stays explicit

The account is part of every surface, so a chat never mixes 2 accounts:

- The thread title is `Review: owner/repo#number as <account>`.
- The first message and each Ask message name the account.
- `get_review` returns `session.account` at the top of its result.
- The skill states the account when it starts, and before each write.
- Publish uses the session's account, as it does today. Nothing in T3 can
  change the account of a session.

#### The project

The thread opens in the T3 project for the PR's repository when one exists.
The app calls `t3_project_list` and matches `repositoryIdentity.provider`
`github`, `owner`, and `name` to the PR, without regard to letter case. A
project whose `repositoryIdentity` is null does not match: T3 sets the identity
from the project's git remote, and the app does not read the user's checkouts.
With no match, the thread is a scratch thread (`scratch: true`).

A project thread uses `workspaceStrategy: { type: "root" }`, so T3 creates no
worktree. The skill reads the code at `headSha` in a temporary worktree and
leaves the user's checkout and branch unchanged, as it does today.

#### Open

When the user opens a review in T3 (button, Ask, or CLI):

1. If the table has a row for the key, call `t3_thread_read` with a limit of 1.
   When the thread exists, use it. If its `session_id` is not the current
   session, send the current session id with `t3_thread_send` and update the
   row.
2. If there is no row or the thread is gone, find the project (see The
   project).
3. Look for a lost thread with `t3_thread_list`, the project, and
   `titleContains` set to the title. Use a match and save it.
4. Otherwise call `t3_thread_launch` with the title, the project or
   `scratch: true`, and the first message. Save the returned `threadId` and
   `link`.

`t3_thread_launch` has no retry key, so the app runs at most 1 open request for
each PR at a time; a second click waits for the first.

The first message:

```text
Use the guided-review skill to discuss review <session id> of <owner/repo#n>,
reviewed as the GitHub account <account>.
The review app is at <app url>; its MCP server is "guided-review".
First, open <app url>/#/s/<session id> in the preview pane with
preview_open. Then call get_review, and wait for my questions.
```

The page shows **Open in T3** when the app has a T3 connection, and the
thread's link after the thread exists. **Copy prompt** stays for users without
T3.

### Ask

The **Ask** button shows on a selection in the diff, on a finding, and on a
flow step's highlight. It opens a small text box. On send, the page calls
`POST /api/sessions/:id/ask` with the text and the focus. The app finds or
creates the PR's thread (see Review threads), then calls `t3_thread_send` with
`mode: "auto"` and a `clientRequestId` from the page. The message:

```text
About src/api.ts:38–45 (finding 2 of review <session id>, as <account>):
<the user's text>
```

Without a T3 connection, the button is hidden.

### CLI and T3 actions

`agent-workflows open <pr>` calls the running app: it creates a session for the
PR when none is ready, waits for the guide, and opens the PR's thread. It
prints the thread link. It does not start a server.

The README suggests 2 T3 actions, which the user adds in T3's project or
environment settings:

| Action           | Command                                                |
| ---------------- | ------------------------------------------------------ |
| Start review app | `mise run start`, or `docker compose up -d`            |
| Review PR        | `read -r "pr?PR: " && pnpm agent-workflows open "$pr"` |

The repo does not ship a `t3.json`, because the actions belong to the user's
environment and not to the repos that they review.

### Skill

`guided-review` in vstack uses the MCP tools when the `guided-review` MCP server
is available, and the HTTP API with `curl` when it is not. It calls `get_focus`
when the user says "this" or "here". It still asks the user to confirm each
write.

## Security

- The MCP endpoint and the API listen on `127.0.0.1` only, with the same Host
  and Origin checks.
- No MCP tool and no T3 message can publish to GitHub.
- The T3 token lives only in the app's database. Logs and API responses never
  contain it.
- The T3 thread runs with the permission mode the user approved, or a narrower
  one.

## Errors

| Case                                | Result                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| T3 is not running                   | Open in T3 and Ask fail with "T3 is not reachable at <url>".            |
| Token expired or removed            | The app deletes the token; the page shows Connect T3.                   |
| Thread deleted in T3                | The next open creates a new thread and replaces the row.                |
| The agent does not open the preview | The user opens it from the thread link; nothing else breaks.            |
| Focus is for another review         | `get_focus` returns it with its PR name; the skill says so to the user. |

## Testing

All tests drive the real app, as the current integration tests do.

- A fake T3 server in the test harness: OAuth metadata, registration,
  authorize (approves at once), token, and an MCP endpoint with
  `t3_project_list`, `t3_thread_list`, `t3_thread_read`, `t3_thread_launch`, and
  `t3_thread_send`. It records each call.
- Tests:
  - Connect, then disconnect.
  - A first open launches 1 thread; a second open of the same PR launches none.
  - A different PR gets a different thread, and so does the same PR as
    another account.
  - A PR whose repository is a T3 project opens in that project; another PR
    opens as a scratch thread.
  - A deleted thread is replaced.
  - A 401 clears the connection.
  - Ask sends 1 message with the file and lines.
  - Each MCP tool changes the review, as the API does, and the events stream
    reports the change.
  - `get_focus` returns the last focus.
  - `open` prints the thread link.

## To verify in the plan

- The form of the `link` that `t3_thread_launch` returns, and whether a browser
  opens it.
- That a Claude thread in T3 loads the `guided-review` MCP server from the
  user's Claude config.
