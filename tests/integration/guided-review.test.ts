import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { world, type App, type World } from "./harness/app.js";

const GREET =
  "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n";

let w: World;
let app: App;
let headSha: string;

before(async () => {
  w = await world();
  headSha = w.github.addPull(
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
      "greet.ts": GREET,
      "app.ts":
        'import { greet } from "./greet";\nexport function main(): string {\n  return greet("widget");\n}\n',
    },
  );
  app = await w.start();
});

after(() => w.close());

test("a guided review runs end to end and publishes one review", async () => {
  const created = await app.api("POST", "sessions", {
    target: "acme/widgets#1",
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const ready = await app.settle(id);
  assert.equal(ready.session.status, "ready", ready.session.error);
  assert.equal(ready.session.account, "octocat");
  assert.equal(ready.session.pr.headSha, headSha);
  assert.deepEqual(
    ready.session.pr.files.map((f: { path: string }) => f.path).sort(),
    ["app.ts", "greet.ts"],
  );
  // The fake agent read these files from the real checkout at the PR head.
  const chapters = ready.session.guide.value.chapters;
  assert.deepEqual(
    chapters.flatMap((c: { files: string[] }) => c.files).sort(),
    ["app.ts", "greet.ts"],
  );
  assert.equal(ready.findings.length, 1);
  const [finding] = ready.findings;
  assert.equal(finding.severity, "high");

  const verdict = await app.api(
    "PUT",
    `sessions/${id}/findings/${finding.id}`,
    {
      verdict: "agree",
      note: "empty names reach the template",
    },
  );
  assert.equal(verdict.status, 200);
  assert.equal(verdict.body.human.verdicts[finding.id].verdict, "agree");

  const comment = await app.api("POST", `sessions/${id}/comments`, {
    path: "greet.ts",
    line: 2,
    body: "Prefer a template constant.",
  });
  assert.equal(comment.status, 201);
  const extra = await app.api("POST", `sessions/${id}/comments`, {
    path: "app.ts",
    line: 1,
    body: "Remove me.",
  });
  const removed = await app.api(
    "DELETE",
    `sessions/${id}/comments/${extra.body.human.comments[1].id}`,
  );
  assert.deepEqual(
    removed.body.human.comments.map((c: { body: string }) => c.body),
    ["Prefer a template constant."],
  );

  const chapter = await app.api(
    "PUT",
    `sessions/${id}/chapters/${chapters[0].id}`,
    { reviewed: true },
  );
  assert.deepEqual(chapter.body.human.chapters, { [chapters[0].id]: true });
  const file = await app.api("PUT", `sessions/${id}/files`, {
    path: "greet.ts",
    viewed: true,
  });
  assert.deepEqual(file.body.human.files, { "greet.ts": true });

  const discuss = await app.api("GET", `sessions/${id}/discuss`);
  assert.match(discuss.body.prompt, /my verdict: agree/);

  const preview = await app.api(
    "GET",
    `sessions/${id}/publish?event=REQUEST_CHANGES`,
  );
  assert.equal(preview.body.preview.event, "REQUEST_CHANGES");
  assert.equal(preview.body.preview.comments.length, 2);

  const unconfirmed = await app.api("POST", `sessions/${id}/publish`, {
    event: "REQUEST_CHANGES",
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(w.github.posted.length, 0);

  const published = await app.api("POST", `sessions/${id}/publish`, {
    event: "REQUEST_CHANGES",
    confirm: true,
  });
  assert.equal(published.status, 200);
  assert.equal(w.github.posted.length, 1);
  const [review] = w.github.posted;
  assert.equal(review.path, "/repos/acme/widgets/pulls/1/reviews");
  assert.equal(review.token, "tok-octocat");
  assert.equal(review.body.event, "REQUEST_CHANGES");
  assert.equal(review.body.commit_id, headSha);
  assert.deepEqual(
    (review.body.comments as Array<{ path: string; line: number }>)
      .map((c) => `${c.path}:${c.line}`)
      .sort(),
    [`${finding.path}:${finding.line}`, "greet.ts:2"].sort(),
  );

  const again = await app.api("POST", `sessions/${id}/publish`, {
    event: "COMMENT",
    confirm: true,
  });
  assert.equal(again.status, 409);
});

test("a rerun keeps the human's verdicts", async () => {
  const { body } = await app.api("POST", "sessions", {
    target: "https://github.com/acme/widgets/pull/1",
    account: "octo-work",
  });
  const first = await app.settle(body.id);
  assert.equal(first.session.account, "octo-work");
  const findingId = first.findings[0].id;
  await app.api("PUT", `sessions/${body.id}/findings/${findingId}`, {
    verdict: "disagree",
    note: "handled upstream",
  });

  const rerun = await app.api("POST", `sessions/${body.id}/rerun`, {});
  assert.equal(rerun.status, 201);
  const second = await app.settle(rerun.body.id);
  assert.equal(second.session.status, "ready");
  assert.equal(second.human.verdicts[findingId].verdict, "disagree");
});

test("the session list shows each run", async () => {
  const { body } = await app.api("GET", "sessions");
  assert.ok(body.sessions.length >= 2);
  assert.ok(
    body.sessions.every(
      (s: { repo: { repo: string } }) => s.repo.repo === "widgets",
    ),
  );
});

test("an agent that writes no report fails the session with the reason", async () => {
  w.github.addPull(
    {
      owner: "acme",
      repo: "widgets",
      number: 2,
      title: "Quiet change [silent]",
      author: "octo-work",
      baseRef: "main",
      headRef: "chore/quiet",
    },
    { "quiet.ts": "export const quiet = true;\n" },
  );
  const { body } = await app.api("POST", "sessions", {
    target: "acme/widgets#2",
  });
  const settled = await app.settle(body.id);
  assert.equal(settled.session.status, "failed");
  assert.match(
    settled.session.error,
    /Guide: agent produced no report .*Review: agent produced no report/,
  );
});

test("bad input gets a 4xx with a reason", async () => {
  const cases: Array<[string, string, unknown, number]> = [
    ["POST", "sessions", { target: "not a pr" }, 400],
    ["POST", "sessions", { target: "acme/widgets#1", account: "nobody" }, 400],
    ["GET", "sessions/missing", undefined, 404],
    ["PUT", "accounts/current", { login: "nobody" }, 400],
    ["GET", "nothing-here", undefined, 404],
  ];
  for (const [method, path, body, status] of cases) {
    const res = await app.api(method, path, body);
    assert.equal(res.status, status, `${method} ${path}`);
    assert.equal(typeof res.body.error, "string");
  }
});
