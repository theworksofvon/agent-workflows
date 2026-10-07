import test from "node:test";
import assert from "node:assert/strict";
import { composeReview } from "../../src/domain/publish.js";
import {
  MARKER_TAG,
  findingId,
  type ReviewFinding,
} from "../../src/domain/decisions.js";
import type {
  HumanState,
  ReviewSession,
} from "../../src/adapters/state/review-sessions.js";

const files = [
  {
    path: "a.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: "@@ -1,1 +1,3 @@\n x\n+y\n+z",
  },
  { path: "b.ts", status: "added", additions: 1, deletions: 0, patch: null },
];

const f1: ReviewFinding = {
  path: "a.ts",
  line: 2,
  body: "first line\nmore",
  severity: "high",
};
const f2: ReviewFinding = {
  path: "a.ts",
  line: 3,
  body: "two",
  severity: "low",
};
const f3: ReviewFinding = {
  path: "a.ts",
  line: 9,
  body: "three",
  severity: "medium",
};
const f4: ReviewFinding = {
  path: "b.ts",
  line: 1,
  body: "four",
  severity: "low",
};

function session(over: Partial<ReviewSession> = {}): ReviewSession {
  return {
    guide: {
      value: {
        overview: { context: "", steps: [], flows: [] },
        chapters: [
          { id: "c1", title: "", role: "core", summary: "", files: ["a.ts"] },
          { id: "c2", title: "", role: "tests", summary: "", files: [] },
        ],
      },
      error: null,
    },
    review: {
      value: { summary: "All good.", findings: [f1, f2, f3, f4] },
      error: null,
      adversarial: false,
    },
    ...over,
  } as ReviewSession;
}

const human = (over: Partial<HumanState> = {}): HumanState => ({
  chapters: {},
  files: {},
  verdicts: {},
  comments: [],
  ...over,
});

const verdict = (v: "agree" | "disagree" | "unsure", note = "") => ({
  verdict: v,
  note,
  updatedAt: "t",
});

test("agent findings are labelled by verdict, with marker and note", () => {
  const out = composeReview({
    session: session(),
    human: human({
      verdicts: {
        [findingId(f1)]: verdict("agree", "yes"),
        [findingId(f2)]: verdict("unsure"),
        [findingId(f3)]: verdict("unsure", "hm"),
      },
    }),
    event: "COMMENT",
    files,
  });
  assert.equal(out.event, "COMMENT");
  assert.deepEqual(out.comments, [
    {
      path: "a.ts",
      line: 2,
      body: `${MARKER_TAG}\n**Agent finding · high · reviewer agrees**\n\nfirst line\nmore\n\n> Reviewer: yes`,
    },
    {
      path: "a.ts",
      line: 3,
      body: `${MARKER_TAG}\n**Agent finding · low · reviewer unsure**\n\ntwo`,
    },
  ]);
  assert.deepEqual(
    out.skipped.map((s) => [s.kind, s.path, s.line]),
    [
      ["agent", "a.ts", 9],
      ["agent", "b.ts", 1],
    ],
  );
});

test("unchecked findings and human comments", () => {
  const out = composeReview({
    session: session({
      review: {
        value: { summary: "", findings: [f2] },
        error: null,
        adversarial: false,
      },
    }),
    human: human({
      comments: [
        { id: "1", path: "a.ts", line: 2, body: "mine", createdAt: "t" },
        { id: "2", path: "z.ts", line: 9, body: "gone", createdAt: "t" },
      ],
    }),
    event: "APPROVE",
    files,
  });
  assert.equal(out.event, "APPROVE");
  assert.deepEqual(out.comments, [
    { path: "a.ts", line: 2, body: "mine" },
    {
      path: "a.ts",
      line: 3,
      body: `${MARKER_TAG}\n**Agent finding · low · not yet checked by a human**\n\ntwo`,
    },
  ]);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]?.kind, "human");
  assert.ok(out.skipped[0]?.reason.length);
  assert.ok(!out.body.includes("### Agent summary"));
  assert.ok(out.body.includes("2 human comments"));
  assert.ok(out.body.includes("agree 0 · disagree 0 · unsure 0 · unchecked 1"));
  assert.ok(
    out.body.includes(
      "### Comments outside the diff\n\n- `z.ts:9` (human comment) gone",
    ),
  );
});

test("disagreed findings go to the body only", () => {
  const out = composeReview({
    session: session(),
    human: human({
      chapters: { c1: true, c2: false, gone: true },
      files: { "a.ts": true, "b.ts": false, "zzz.ts": true },
      verdicts: {
        [findingId(f1)]: verdict("disagree", "wrong"),
        [findingId(f2)]: verdict("disagree"),
      },
    }),
    event: "REQUEST_CHANGES",
    files,
  });
  assert.deepEqual(out.comments, []);
  assert.equal(out.event, "REQUEST_CHANGES");
  assert.ok(out.body.startsWith(`${MARKER_TAG}\n\n## Guided review\n\n`));
  assert.ok(
    out.body.includes("1 of 2 chapters and 1 of 2 files reviewed by a human."),
  );
  assert.ok(out.body.includes("agree 0 · disagree 2 · unsure 0 · unchecked 2"));
  assert.ok(out.body.includes("### Agent summary\n\nAll good."));
  assert.ok(
    out.body.includes(
      "### Agent findings the reviewer rejected\n\n- `a.ts:2` (high) first line — **Reviewer:** wrong\n- `a.ts:3` (low) two — **Reviewer:** no reason given",
    ),
  );
});

test("missing guide and review", () => {
  const out = composeReview({
    session: session({
      guide: { value: null, error: "x" },
      review: { value: null, error: "x", adversarial: false },
    }),
    human: human(),
    event: "COMMENT",
    files,
  });
  assert.ok(out.body.includes("0 of 0 chapters and 0 of 2 files"));
  assert.ok(out.body.includes("0 human comments"));
  assert.deepEqual(out.comments, []);
});

test("a single human comment uses the singular", () => {
  const out = composeReview({
    session: session(),
    human: human({
      comments: [
        { id: "1", path: "a.ts", line: 2, body: "mine", createdAt: "t" },
      ],
    }),
    event: "COMMENT",
    files,
  });
  assert.ok(out.body.includes("1 human comment."));
});
