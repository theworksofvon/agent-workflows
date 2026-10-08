import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { world, type App, type World } from "./harness/app.js";

let w: World;
let app: App;
let review: string;
let finding: string;

before(async () => {
  w = await world();
  w.github.addPull(
    {
      owner: "acme",
      repo: "widgets",
      number: 1,
      title: "Add greet",
      author: "octo-work",
      baseRef: "main",
      headRef: "feat/greet",
    },
    {
      "greet.ts":
        "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
    },
  );
  app = await w.start();
  const { body } = await app.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  review = body.id;
  finding = (await app.settle(review)).findings[0].id;
});

after(() => w.close());

test("the MCP tools read and change a review as the API does", async () => {
  const read = await app.mcp("get_review", { review });
  assert.equal(read.data.session.account, "octocat");
  assert.equal(read.data.findings[0].id, finding);

  const verdict = await app.mcp("set_verdict", {
    review,
    finding,
    verdict: "agree",
    note: "real bug",
  });
  assert.equal(verdict.data.human.verdicts[finding].verdict, "agree");

  const added = await app.mcp("add_comment", {
    review,
    path: "greet.ts",
    line: 2,
    body: "Use a constant.",
  });
  const comment = added.data.human.comments[0].id;
  await app.mcp("mark_reviewed", { review, path: "greet.ts", reviewed: true });
  const removed = await app.mcp("delete_comment", { review, comment });
  assert.deepEqual(removed.data.human.comments, []);
  assert.deepEqual(removed.data.human.files, { "greet.ts": true });

  const chapter = read.data.session.guide.value.chapters[0].id;
  const marked = await app.mcp("mark_reviewed", {
    review,
    chapter,
    reviewed: true,
  });
  assert.deepEqual(marked.data.human.chapters, { [chapter]: true });
});

test("a refused tool call is a tool error, and nothing publishes", async () => {
  const missing = await app.mcp("get_review", { review: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.data, /review session not found/);
  const tools = await app.mcpTools();
  assert.deepEqual(tools.sort(), [
    "add_comment",
    "delete_comment",
    "get_focus",
    "get_review",
    "mark_reviewed",
    "set_verdict",
  ]);
});

test("a write from MCP reaches the page's event stream", async () => {
  const stream = app.events(review);
  assert.equal(await stream.next(), "ready");
  await app.mcp("set_verdict", {
    review,
    finding,
    verdict: "unsure",
    note: "",
  });
  assert.equal(await stream.next(), "changed");
  stream.close();
  assert.equal((await app.api("GET", "sessions/nope/events")).status, 404);
});

test("the page's focus reaches get_focus with the PR and account", async () => {
  assert.equal((await app.mcp("get_focus", {})).data.focus, null);
  const set = await app.api("PUT", "focus", {
    review,
    tab: "diff",
    chapter: null,
    finding: null,
    path: "greet.ts",
    lines: { start: 1, end: 2 },
  });
  assert.equal(set.status, 200);
  const { data } = await app.mcp("get_focus", {});
  assert.equal(data.focus.pr, "acme/widgets#1");
  assert.equal(data.focus.account, "octocat");
  assert.deepEqual(data.focus.lines, { start: 1, end: 2 });

  const cases: unknown[] = [
    { review, tab: "nope" },
    { review, tab: "diff", path: 3 },
    { review, tab: "diff", lines: { start: 2, end: 1 } },
    { review: "missing", tab: "diff" },
  ];
  for (const body of cases)
    assert.ok((await app.api("PUT", "focus", body)).status >= 400);
});

test("the MCP endpoint takes POST only", async () => {
  const res = await fetch(`${app.url}/mcp`);
  assert.equal(res.status, 405);
});
