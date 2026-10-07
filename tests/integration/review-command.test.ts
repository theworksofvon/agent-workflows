import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { world, type World } from "./harness/app.js";

let w: World;

before(async () => {
  w = await world();
  w.github.addPull(
    {
      owner: "acme",
      repo: "widgets",
      number: 3,
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
});

after(() => w.close());

test("review prints the findings without posting by default", async () => {
  const r = await w.cli(["review", "acme/widgets#3"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Review dry-run for acme\/widgets#3/);
  assert.match(
    r.stdout,
    /- greet\.ts:1 \[high\] greet\(\) ignores an empty name\./,
  );
  assert.equal(w.github.posted.length, 0);
});

test("review --post posts the new findings once", async () => {
  const first = await w.cli(["review", "acme/widgets#3", "--post"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Review posted for acme\/widgets#3/);
  assert.equal(w.github.posted.length, 1);
  assert.equal(w.github.posted[0].token, "tok-octocat");

  const second = await w.cli(["review", "acme/widgets#3", "--post"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Skipped duplicate findings: 1/);
  assert.equal(w.github.posted.length, 1);
});

test("review --adversarial runs the second pass", async () => {
  const r = await w.cli(["review", "acme/widgets#3", "--adversarial"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Adversarial review: ran/);
});

test("GITHUB_TOKEN stands in when gh has no account", async () => {
  const r = await w.cli(["review", "acme/widgets#3"], {
    FAKE_GH_ACCOUNTS: "",
    GITHUB_TOKEN: "tok-ci-bot",
  });
  assert.equal(r.status, 0, r.stderr);
});

test("bad arguments and settings exit 1 with the reason", async () => {
  const cases: Array<[string[], Record<string, string>, RegExp]> = [
    [["review"], {}, /Usage: pnpm review/],
    [["review", "a/b#1", "c/d#2"], {}, /accepts one PR target/],
    [
      ["review", "a/b#1", "--post", "--dry-run"],
      {},
      /either --post or --dry-run/,
    ],
    [["review", "a/b#1", "--nope"], {}, /Unknown review option/],
    [["review", "not-a-pr"], {}, /Invalid PR target/],
    [["frobnicate"], {}, /Unknown command: frobnicate/],
    [["start", "--nope"], {}, /Unknown start option/],
    [["start"], { UI_PORT: "99999" }, /UI_PORT must be an integer/],
    [["start"], { AGENT: "zcode" }, /ZCode support was removed/],
    [["review", "a/b#1"], { FAKE_GH_ACCOUNTS: "" }, /GITHUB_TOKEN/],
  ];
  for (const [args, env, reason] of cases) {
    const r = await w.cli(args, env);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout + r.stderr, reason, args.join(" "));
  }
});

test("help lists the commands", async () => {
  const r = await w.cli(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /start {4}Serve the guided review app/);
  assert.match(r.stdout, /review {3}Run a read-only pull-request review/);
});

test("a retired variable warns and does not stop startup", async () => {
  const app = await w.start({ TAILSCALE_FUNNEL: "true", LOG_LEVEL: "warn" });
  assert.equal(await app.stop(), 0);
});
