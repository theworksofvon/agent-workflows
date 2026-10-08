# Review Threads in T3 Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discuss a guided review in 1 T3 Code thread per account and PR, with the review page beside the chat, and context that goes both ways.

**Architecture:** The app serves an MCP endpoint (`/mcp`) whose tools call the same `ReviewApi` methods as the HTTP routes. A change counter per session feeds a server-sent events stream, so the page updates when an agent writes. The app signs in to T3's outside-agent MCP endpoint with OAuth (PKCE, dynamic client registration) and keeps a table that maps `account:owner/repo#n` to a T3 thread.

**Tech Stack:** Node 24, TypeScript, `node:sqlite`, `@modelcontextprotocol/sdk` 1.32.1 (server and client), `zod` 4, React 19 and Vite for the page, the Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-07-t3-review-threads-design.md`

## Global Constraints

- No MCP tool and no T3 message can publish to GitHub. `publish` stays an HTTP route that needs `confirm: true`.
- The account is explicit: thread key `account:owner/repo#number`, thread title `Review: owner/repo#number as <account>`, and the account in every message to T3.
- The T3 token lives only in the `settings` table. It never goes to a log or an API response.
- `/mcp` and `/api` share the Host and Origin checks in `review-server.ts`.
- Tests drive the real app as a child process. Only GitHub, `gh`, the agent CLI, and T3 are fake.
- Coverage floor stays at 90% lines, 65% branches, 90% functions.
- Update `CHANGELOG.md` with the change.

## File Structure

| File                                                                         | Responsibility                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/services/review-events.ts` (new)                                        | Change counter and subscribers for each session                       |
| `src/services/focus.ts` (new)                                                | The last focus that the page reported, validated, in memory           |
| `src/services/review-tools.ts` (new)                                         | Registers the review MCP tools on an `McpServer`                      |
| `src/adapters/http/mcp-endpoint.ts` (new)                                    | Stateless Streamable HTTP handling for `/mcp`                         |
| `src/adapters/t3/oauth.ts` (new)                                             | T3 OAuth: metadata, registration, authorize URL, code exchange        |
| `src/adapters/t3/t3-client.ts` (new)                                         | Calls a T3 MCP tool with the token; maps 401 to `T3UnauthorizedError` |
| `src/adapters/state/t3-threads.ts` (new)                                     | The `t3_threads` table                                                |
| `src/services/t3-link.ts` (new)                                              | Connection state, the open flow, and Ask                              |
| `src/services/review-api.ts`                                                 | Emits changes; exposes focus; delegates T3 operations                 |
| `src/adapters/http/review-server.ts`                                         | `/mcp`, the events stream, the OAuth callback, new routes             |
| `src/adapters/state/sqlite.ts`                                               | `t3_threads` schema                                                   |
| `src/config.ts`                                                              | `T3_MCP_URL`                                                          |
| `src/main.ts`                                                                | Wiring and the `open` command                                         |
| `tests/integration/harness/fake-t3.ts` (new)                                 | Fake T3: OAuth and MCP tools, with a call log                         |
| `tests/integration/harness/app.ts`                                           | Starts the fake T3; exposes `mcp()` and `events()` helpers            |
| `tests/integration/review-mcp.test.ts` (new)                                 | MCP tools, focus, events                                              |
| `tests/integration/t3.test.ts` (new)                                         | Connect, threads, Ask, `open`                                         |
| `web/src/api.ts`, `web/src/types.ts`                                         | New calls and types                                                   |
| `web/src/lib/live.ts` (new)                                                  | Events subscription and focus reporting hooks                         |
| `web/src/components/T3Dialog.tsx` (new)                                      | Connect T3 and copy prompt fallback                                   |
| `web/src/components/AskBox.tsx` (new)                                        | Ask in T3 popover                                                     |
| `web/src/pages/Session.tsx`, `TopBar.tsx`, `FileDiff.tsx`, `FindingCard.tsx` | Wire the above                                                        |
| `README.md`, `CHANGELOG.md`                                                  | Docs                                                                  |
| vstack `skills/guided-review/SKILL.md`                                       | MCP tools first, `curl` second                                        |

---

### Task 1: Review MCP endpoint

**Files:**

- Create: `src/services/review-tools.ts`, `src/adapters/http/mcp-endpoint.ts`, `tests/integration/review-mcp.test.ts`
- Modify: `src/adapters/http/review-server.ts`, `src/services/review-api.ts`, `tests/integration/harness/app.ts`, `package.json`

**Interfaces:**

- Produces: `registerReviewTools(server: McpServer, api: ReviewApi): void`; `handleMcp(req, res, raw: string, api: ReviewApi): Promise<void>`; harness `App.mcp(tool: string, args: object): Promise<{ isError: boolean; data: Json }>`.

- [ ] **Step 1: Add the harness helper and the failing test**

`App.mcp` uses the SDK client against `${url}/mcp` and returns `structuredContent` (or the parsed first text block) and `isError`.

```ts
test("the MCP tools read and change a review as the API does", async () => {
  const { body } = await app.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  const ready = await app.settle(body.id);
  const finding = ready.findings[0];

  const review = await app.mcp("get_review", { review: body.id });
  assert.equal(review.data.session.account, "octocat");
  assert.equal(review.data.findings[0].id, finding.id);

  const verdict = await app.mcp("set_verdict", {
    review: body.id,
    finding: finding.id,
    verdict: "agree",
    note: "real bug",
  });
  assert.equal(verdict.data.human.verdicts[finding.id].verdict, "agree");

  const added = await app.mcp("add_comment", {
    review: body.id,
    path: "greet.ts",
    line: 2,
    body: "Use a constant.",
  });
  const commentId = added.data.human.comments[0].id;
  await app.mcp("mark_reviewed", {
    review: body.id,
    path: "greet.ts",
    reviewed: true,
  });
  const removed = await app.mcp("delete_comment", {
    review: body.id,
    comment: commentId,
  });
  assert.deepEqual(removed.data.human.comments, []);
  assert.deepEqual(removed.data.human.files, { "greet.ts": true });

  const missing = await app.mcp("get_review", { review: "nope" });
  assert.equal(missing.isError, true);
  const tools = await app.mcpTools();
  assert.ok(!tools.includes("publish"));
});
```

- [ ] **Step 2: Run it and see it fail** — `mise run test` fails: 404 on `/mcp`.

- [ ] **Step 3: Implement**

`review-tools.ts` registers 6 tools with zod input schemas. Each handler calls the `ReviewApi` method and returns `{ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }`. A thrown `DomainError` becomes `{ isError: true, content: [{ type: "text", text: message }] }`. `get_review` and `get_focus` have `annotations: { readOnlyHint: true }`. `mark_reviewed` takes `chapter` or `path` and calls `setChapter` or `setFile`.

`mcp-endpoint.ts` builds a new `McpServer` and a `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` per request, connects them, and calls `transport.handleRequest(req, res, JSON.parse(raw))`. GET and DELETE answer 405.

`review-server.ts` routes `/mcp` through `refuse()` and `readBody()` to `handleMcp`.

- [ ] **Step 4: Run** `mise run test` — PASS.
- [ ] **Step 5: Commit** `feat: serve the review over MCP at /mcp`

### Task 2: Live page

**Files:**

- Create: `src/services/review-events.ts`, `web/src/lib/live.ts`
- Modify: `src/services/review-api.ts`, `src/adapters/http/review-server.ts`, `src/main.ts`, `web/src/pages/Session.tsx`, `tests/integration/review-mcp.test.ts`, harness

**Interfaces:**

- Produces: `reviewEvents(): { changed(id: string): void; subscribe(id: string, fn: () => void): () => void }`; `ReviewApiPorts.events`; `ReviewApi.subscribe(id, fn)`; harness `App.events(id): { next(): Promise<string>; close(): void }`.

- [ ] **Step 1: Failing test**

```ts
test("a write from MCP reaches the page's event stream", async () => {
  const { body } = await app.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  const ready = await app.settle(body.id);
  const stream = app.events(body.id);
  await stream.next(); // the stream opens with "ready"
  await app.mcp("set_verdict", {
    review: body.id,
    finding: ready.findings[0].id,
    verdict: "unsure",
    note: "",
  });
  assert.equal(await stream.next(), "changed");
  stream.close();
});
```

- [ ] **Step 2: Run and see it fail** (404 on the events path).
- [ ] **Step 3: Implement.** Every human write in `ReviewApi` (`setChapter`, `setFile`, `setVerdict`, `addComment`, `deleteComment`) and `publish` calls `ports.events.changed(id)`. `GET /api/sessions/:id/events` answers `text/event-stream`, writes `event: ready`, and writes `event: changed` on each change, with a comment line each 25 s so proxies keep the stream. The page opens an `EventSource` in `useLiveSession(id, load)` and calls `load()` on `changed`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: the review page updates when an agent writes`

### Task 3: Focus

**Files:**

- Create: `src/services/focus.ts`
- Modify: `review-api.ts`, `review-server.ts`, `review-tools.ts`, `web/src/lib/live.ts`, `web/src/pages/Session.tsx`, `web/src/components/FileDiff.tsx`, test

**Interfaces:**

- Produces: `Focus = { review: string; pr: string; account: string; tab: "overview" | "guide" | "diff"; chapter: string | null; finding: string | null; path: string | null; lines: { start: number; end: number } | null; at: string }`; `ReviewApi.setFocus(body): { focus: Focus }`; `ReviewApi.getFocus(): { focus: Focus | null }`; web `useFocusReport(input)`; `data-line` on each diff row.

- [ ] **Step 1: Failing test**

```ts
test("the page's focus reaches get_focus with the PR and account", async () => {
  const { body } = await app.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  await app.settle(body.id);
  assert.equal((await app.mcp("get_focus", {})).data.focus, null);
  await app.api("PUT", "focus", {
    review: body.id,
    tab: "diff",
    chapter: null,
    finding: null,
    path: "greet.ts",
    lines: { start: 1, end: 2 },
  });
  const { data } = await app.mcp("get_focus", {});
  assert.equal(data.focus.pr, "acme/widgets#1");
  assert.equal(data.focus.account, "octocat");
  assert.deepEqual(data.focus.lines, { start: 1, end: 2 });
  const bad = await app.api("PUT", "focus", { review: body.id, tab: "nope" });
  assert.equal(bad.status, 400);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** `focus.ts` validates the body (known session, known tab, `lines` positive integers with `end >= start`) and adds `pr`, `account`, and `at`. The page reports `{ tab, chapter, finding, path, lines }` 500 ms after it changes: `path` is the current file, `lines` comes from a text selection inside a diff (the `data-line` of the first and last selected rows) or from a flow step's highlight, and `finding` is the finding that was last opened.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: get_focus tells the agent what the reviewer has open`

### Task 4: T3 sign-in

**Files:**

- Create: `src/adapters/t3/oauth.ts`, `src/adapters/t3/t3-client.ts`, `src/services/t3-link.ts`, `tests/integration/harness/fake-t3.ts`, `tests/integration/t3.test.ts`
- Modify: `src/config.ts`, `review-api.ts`, `review-server.ts`, `main.ts`, harness

**Interfaces:**

- Produces:
  - `t3OAuth(mcpUrl: string)`: `{ register(redirectUri): Promise<string /* clientId */>; authorizeUrl(a: { clientId; redirectUri; state; challenge }): Promise<string>; exchange(a: { clientId; redirectUri; code; verifier }): Promise<{ token: string; expiresAt: string }> }`. Metadata comes from `<origin>/.well-known/oauth-authorization-server`; `resource` is `<origin>/mcp`.
  - `t3Call(mcpUrl, token, tool, args): Promise<Json>`; throws `T3UnauthorizedError` on 401 and `T3UnreachableError` when the fetch fails.
  - `t3Link({ settings, threads, config, publicUrl })`: `status()`, `connect(body)`, `callback(query)`, `disconnect()`, `openThread(session)`, `ask(session, body)`.
  - Routes: `GET /api/t3`, `POST /api/t3/connect`, `GET /api/t3/callback` (302 to `/#/?t3=connected` or `/#/?t3=failed`), `DELETE /api/t3`.
  - Fake T3: `startFakeT3()` returns `{ mcpUrl, calls, projects, threads, revokeTokens(), deleteThread(id), close() }`.

- [ ] **Step 1: Failing test**

```ts
test("connect signs in with OAuth and disconnect forgets the token", async () => {
  assert.deepEqual((await app.api("GET", "t3")).body, {
    connected: false,
    mcpUrl: t3.mcpUrl,
  });
  await connectT3(app); // POST connect, follow the fake's authorize redirect to the callback
  const status = (await app.api("GET", "t3")).body;
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes("tok"), false);
  assert.equal((await app.api("DELETE", "t3")).body.connected, false);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** `connect` registers the client when `settings` has no `t3.clientId` for that URL, makes a PKCE verifier (32 random bytes, base64url) and an S256 challenge, keeps `{ verifier }` under a random `state` for 10 minutes, and returns `{ authorizeUrl }`. `callback` checks the `state`, exchanges the code, and stores `t3.token` and `t3.expiresAt`. A token past `expiresAt`, or a 401 from T3, clears `t3.token`. The redirect URI is `http://127.0.0.1:<UI_PUBLIC_PORT>/api/t3/callback`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sign in to T3 Code with its outside-agent OAuth`

### Task 5: 1 thread for each account and PR

**Files:**

- Create: `src/adapters/state/t3-threads.ts`
- Modify: `sqlite.ts`, `t3-link.ts`, `review-api.ts`, `review-server.ts`, `fake-t3.ts`, `t3.test.ts`

**Interfaces:**

- Produces: `T3ThreadStore { get(key): T3ThreadRow | null; save(row): void }`; `T3ThreadRow { key; threadId; link; projectId: string | null; sessionId; createdAt }`; route `POST /api/sessions/:id/t3` returning `{ thread: { id, title, link, url: string | null, created: boolean } }`.

- [ ] **Step 1: Failing tests**

```ts
test("a review opens 1 thread for each account and PR", async () => {
  const a = await reviewOf("acme/widgets#1");
  const first = await app.api("POST", `sessions/${a}/t3`, {});
  assert.equal(first.body.thread.created, true);
  assert.equal(first.body.thread.title, "Review: acme/widgets#1 as octocat");
  const launch = t3.calls.find((c) => c.tool === "t3_thread_launch")!;
  assert.equal(launch.args.projectId, "proj-widgets");
  assert.match(launch.args.message, /as the GitHub account octocat/);
  assert.match(launch.args.message, /preview_open/);

  const again = await app.api("POST", `sessions/${a}/t3`, {});
  assert.equal(again.body.thread.id, first.body.thread.id);
  assert.equal(launches(), 1);

  const other = await reviewOf("acme/widgets#1", "octo-work");
  const third = await app.api("POST", `sessions/${other}/t3`, {});
  assert.notEqual(third.body.thread.id, first.body.thread.id);

  const scratch = await reviewOf("acme/gadgets#4");
  await app.api("POST", `sessions/${scratch}/t3`, {});
  assert.equal(lastLaunch().args.scratch, true);

  t3.deleteThread(first.body.thread.id);
  const replaced = await app.api("POST", `sessions/${a}/t3`, {});
  assert.notEqual(replaced.body.thread.id, first.body.thread.id);
});

test("a rerun tells the existing thread about the new session", async () => {
  /* rerun, open, expect 1 t3_thread_send naming the new id */
});
test("a 401 from T3 clears the connection", async () => {
  /* t3.revokeTokens(); open → 409 "connect T3"; GET t3 → connected false */
});
test("T3 down is a 502 with the URL", async () => {
  /* close fake; open → 502 /not reachable/ */
});
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the open flow from the spec, with 1 in-flight promise per key. Project match: `repositoryIdentity.provider === "github"` and owner and name equal, case-insensitive. Launch with `workspaceStrategy: { type: "root" }` for a project, or `scratch: true`. `url` is `<T3 origin>/<environmentId>/<threadId>` from the `t3-thread://v1/<env>/<thread>` link, or null when the link does not parse.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: open each review in its own T3 thread`

### Task 6: Ask

**Files:** Modify `t3-link.ts`, `review-api.ts`, `review-server.ts`, `t3.test.ts`

**Interfaces:** Produces route `POST /api/sessions/:id/ask` with `{ text, path?, lines?, finding?, requestId }`, returning `{ thread }`.

- [ ] **Step 1: Failing test**

```ts
test("Ask sends 1 message with the lines, the finding, and the account", async () => {
  const id = await reviewOf("acme/widgets#1");
  const res = await app.api("POST", `sessions/${id}/ask`, {
    text: "Is this safe?",
    path: "greet.ts",
    lines: { start: 1, end: 2 },
    requestId: "r1",
  });
  assert.equal(res.status, 200);
  const sent = t3.calls.filter((c) => c.tool === "t3_thread_send").at(-1)!;
  assert.match(
    sent.args.message,
    /^About greet\.ts:1–2 \(review .+, as octocat\):\nIs this safe\?$/,
  );
  assert.equal(sent.args.clientRequestId, "r1");
  assert.equal(
    (await app.api("POST", `sessions/${id}/ask`, { text: " " })).status,
    400,
  );
});
```

- [ ] **Steps 2–5:** run, implement (open the thread first, then `t3_thread_send` with `mode: "auto"`), run, commit `feat: ask about the open lines in the review's T3 thread`.

### Task 7: The page

**Files:**

- Create: `web/src/components/T3Dialog.tsx`, `web/src/components/AskBox.tsx`
- Modify: `web/src/api.ts`, `web/src/types.ts`, `TopBar.tsx`, `Session.tsx`, `FileDiff.tsx`, `FindingCard.tsx`, `styles.css`, `lib/route.ts` (ignore the `?t3=` query)

- [ ] **Step 1:** `api.t3Status()`, `api.t3Connect(mcpUrl)`, `api.t3Disconnect()`, `api.openInT3(id)`, `api.ask(id, body)`, `api.setFocus(body)`.
- [ ] **Step 2:** **Open in T3**: when connected, call `openInT3` and show a toast "Opened in T3: <title>" with the thread link; when not connected, open `T3Dialog` with the MCP URL field, **Connect** (navigates to `authorizeUrl`), and **Copy prompt instead**.
- [ ] **Step 3:** `AskBox`: an **Ask in T3** button floats over a diff selection, and a small **Ask** button sits in each finding's head. The box sends `api.ask` with a `crypto.randomUUID()` request id. Hidden when not connected.
- [ ] **Step 4:** `mise run web:check` passes. Check the page by hand in a browser against the running app.
- [ ] **Step 5: Commit** `feat(web): open in T3, ask in T3, and connect T3 from the review page`

### Task 8: `open` command

**Files:** Modify `src/main.ts`, `tests/integration/t3.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("open starts a review and prints its thread", async () => {
  const r = await w.cli(["open", "acme/widgets#1"], {
    UI_PORT: String(app.port),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Review: acme\/widgets#1 as octocat/);
});
```

- [ ] **Steps 2–5:** run; implement `runOpenCommand`: `POST /api/sessions`, poll `GET /api/sessions/:id` each 1 s up to 15 minutes, then `POST /api/sessions/:id/t3`; print the title and the thread URL or link; add `open` to help; run; commit `feat: agent-workflows open <pr> opens a review in T3`.

### Task 9: Docs, skill, and a check against the real T3

- [ ] README: "Discuss in T3 Code" section: connect, `claude mcp add --transport http guided-review http://127.0.0.1:4773/mcp`, the 2 T3 actions, Docker `T3_MCP_URL` with `host.docker.internal`.
- [ ] CHANGELOG entry "Review Threads in T3 Code".
- [ ] vstack `skills/guided-review/SKILL.md`: MCP tools first, `curl` second; `get_focus` for "this"; state the account first and before each write.
- [ ] Real T3 check: connect the running app to the local T3, open 1 review, and confirm the thread, its project, the preview pane, and the thread URL. Record what does not work in the CHANGELOG handoff.
- [ ] `mise run gate` passes. Commit `docs: discuss a review in T3 Code`.
