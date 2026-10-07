import test from "node:test";
import assert from "node:assert/strict";
import { parseGuide } from "../../src/domain/guide.js";
import { ReportInvalidError } from "../../src/domain/errors.js";

const paths = ["a.ts", "b.ts", "c.test.ts", "d.md"];

function guide(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    overview: { context: "ctx", steps: ["one"] },
    chapters: [
      { id: "x", title: "X", role: "core", summary: "s", files: ["a.ts"] },
    ],
    ...overrides,
  });
}

function chapters(list: unknown[]): string {
  return guide({ chapters: list });
}

test("valid guide round-trips with trimming and an other chapter", () => {
  const result = parseGuide(
    JSON.stringify({
      overview: {
        context: "  ctx  ",
        steps: [" one "],
        flows: [
          {
            title: " T ",
            caption: " C ",
            before: [{ label: " L ", change: "removed", chapter: "x" }],
            after: [{ label: "M", change: "added", chapter: "x" }],
          },
        ],
      },
      chapters: [
        {
          id: " x ",
          title: " X ",
          role: "core",
          summary: " s ",
          files: [" a.ts "],
        },
      ],
    }),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(result, {
    overview: {
      context: "ctx",
      steps: ["one"],
      flows: [
        {
          title: "T",
          caption: "C",
          before: [{ label: "L", change: "removed", chapter: "x" }],
          after: [{ label: "M", change: "added", chapter: "x" }],
        },
      ],
    },
    chapters: [
      { id: "x", title: "X", role: "core", summary: "s", files: ["a.ts"] },
      {
        id: "other",
        title: "Other changes",
        role: "supporting",
        summary: "Files the guide did not place in a chapter.",
        files: ["b.ts"],
      },
    ],
  });
});

test("flows default to empty and caption defaults to empty", () => {
  assert.deepEqual(parseGuide(guide(), ["a.ts"]).overview.flows, []);
  const withFlow = parseGuide(
    guide({
      overview: {
        context: "c",
        steps: [],
        flows: [{ title: "T", before: [], after: [] }],
      },
    }),
    ["a.ts"],
  );
  assert.equal(withFlow.overview.flows[0]?.caption, "");
});

test("drops unknown paths and removes chapters left empty", () => {
  const result = parseGuide(
    chapters([
      { id: "x", title: "X", role: "core", summary: "", files: ["zzz.ts"] },
      { id: "y", title: "Y", role: "core", summary: "", files: ["a.ts"] },
    ]),
    ["a.ts"],
  );
  assert.deepEqual(
    result.chapters.map((c) => c.id),
    ["y"],
  );
});

test("a duplicate path stays in the first chapter", () => {
  const result = parseGuide(
    chapters([
      { id: "x", title: "X", role: "core", summary: "", files: ["a.ts"] },
      {
        id: "y",
        title: "Y",
        role: "core",
        summary: "",
        files: ["a.ts", "b.ts"],
      },
    ]),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(
    result.chapters.map((c) => [c.id, c.files]),
    [
      ["x", ["a.ts"]],
      ["y", ["b.ts"]],
    ],
  );
});

test("unassigned files go to a final other chapter in changed order", () => {
  const result = parseGuide(guide(), ["d.md", "a.ts", "b.ts"]);
  const last = result.chapters.at(-1);
  assert.equal(last?.id, "other");
  assert.deepEqual(last?.files, ["d.md", "b.ts"]);
});

test("no other chapter when every file is placed", () => {
  const result = parseGuide(guide(), ["a.ts"]);
  assert.deepEqual(
    result.chapters.map((c) => c.id),
    ["x"],
  );
});

test("role sort is stable and other stays last", () => {
  const result = parseGuide(
    chapters([
      { id: "t", title: "T", role: "tests", summary: "", files: ["c.test.ts"] },
      { id: "c1", title: "C1", role: "core", summary: "", files: ["a.ts"] },
      { id: "c2", title: "C2", role: "core", summary: "", files: ["b.ts"] },
    ]),
    [...paths],
  );
  assert.deepEqual(
    result.chapters.map((c) => c.id),
    ["c1", "c2", "t", "other"],
  );
});

test("unknown or missing role becomes supporting", () => {
  const result = parseGuide(
    chapters([
      { id: "x", title: "X", role: "weird", summary: "", files: ["a.ts"] },
      { id: "y", title: "Y", summary: "", files: ["b.ts"] },
    ]),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(
    result.chapters.map((c) => c.role),
    ["supporting", "supporting"],
  );
});

test("flow node chapter and change are normalized", () => {
  const result = parseGuide(
    guide({
      overview: {
        context: "c",
        steps: [],
        flows: [
          {
            title: "T",
            before: [
              { label: "A", change: "weird", chapter: "nope" },
              { label: "B", change: "unchanged" },
            ],
            after: [],
          },
        ],
      },
    }),
    ["a.ts"],
  );
  assert.deepEqual(result.overview.flows[0]?.before, [
    { label: "A", change: "changed", chapter: null },
    { label: "B", change: "unchanged", chapter: null },
  ]);
});

test("flow node may point at the other chapter", () => {
  const result = parseGuide(
    guide({
      overview: {
        context: "c",
        steps: [],
        flows: [
          {
            title: "T",
            before: [],
            after: [{ label: "A", change: "added", chapter: "other" }],
          },
        ],
      },
    }),
    ["a.ts", "b.ts"],
  );
  assert.equal(result.overview.flows[0]?.after[0]?.chapter, "other");
});

test("an agent chapter named other moves to a free id so ids stay unique", () => {
  const result = parseGuide(
    JSON.stringify({
      overview: {
        context: "c",
        steps: [],
        flows: [
          {
            title: "T",
            before: [],
            after: [{ label: "A", change: "added", chapter: "other" }],
          },
        ],
      },
      chapters: [
        {
          id: "other",
          title: "Misc",
          role: "core",
          summary: "",
          files: ["a.ts"],
        },
        {
          id: "other-1",
          title: "Taken",
          role: "core",
          summary: "",
          files: ["b.ts"],
        },
      ],
    }),
    paths,
  );
  assert.deepEqual(
    result.chapters.map((c) => [c.id, c.title]),
    [
      ["other-2", "Misc"],
      ["other-1", "Taken"],
      ["other", "Other changes"],
    ],
  );
  assert.equal(result.overview.flows[0]?.after[0]?.chapter, "other-2");
});

test("rejects invalid guides", () => {
  const cases: Array<[string, string]> = [
    ["not json", "{nope"],
    ["not object", "[]"],
    ["null", "null"],
    ["overview missing", JSON.stringify({ chapters: [] })],
    ["context missing", guide({ overview: { steps: [] } })],
    ["context blank", guide({ overview: { context: " ", steps: [] } })],
    ["steps not array", guide({ overview: { context: "c", steps: "x" } })],
    ["step empty", guide({ overview: { context: "c", steps: [" "] } })],
    [
      "flows not array",
      guide({ overview: { context: "c", steps: [], flows: 1 } }),
    ],
    [
      "chapters missing",
      JSON.stringify({ overview: { context: "c", steps: [] } }),
    ],
    ["chapters empty", chapters([])],
    ["chapter not object", chapters(["x"])],
    [
      "duplicate id",
      chapters([
        { id: "x", title: "X", summary: "", files: [] },
        { id: "x", title: "Y", summary: "", files: [] },
      ]),
    ],
    ["missing id", chapters([{ title: "X", files: [] }])],
    ["missing title", chapters([{ id: "x", files: [] }])],
    ["summary missing", chapters([{ id: "x", title: "X", files: [] }])],
    [
      "summary not string",
      chapters([{ id: "x", title: "X", summary: 1, files: [] }]),
    ],
    [
      "files not array",
      chapters([{ id: "x", title: "X", summary: "", files: "a.ts" }]),
    ],
    [
      "file not string",
      chapters([{ id: "x", title: "X", summary: "", files: [1] }]),
    ],
    [
      "flow not object",
      guide({ overview: { context: "c", steps: [], flows: ["x"] } }),
    ],
    [
      "flow title missing",
      guide({
        overview: {
          context: "c",
          steps: [],
          flows: [{ before: [], after: [] }],
        },
      }),
    ],
    [
      "flow caption not string",
      guide({
        overview: {
          context: "c",
          steps: [],
          flows: [{ title: "T", caption: 1, before: [], after: [] }],
        },
      }),
    ],
    [
      "flow before not array",
      guide({
        overview: {
          context: "c",
          steps: [],
          flows: [{ title: "T", before: 1, after: [] }],
        },
      }),
    ],
    [
      "node not object",
      guide({
        overview: {
          context: "c",
          steps: [],
          flows: [{ title: "T", before: [1], after: [] }],
        },
      }),
    ],
    [
      "node label empty",
      guide({
        overview: {
          context: "c",
          steps: [],
          flows: [
            {
              title: "T",
              before: [{ label: " ", change: "added" }],
              after: [],
            },
          ],
        },
      }),
    ],
  ];
  for (const [name, text] of cases) {
    assert.throws(() => parseGuide(text, ["a.ts"]), ReportInvalidError, name);
  }
});
