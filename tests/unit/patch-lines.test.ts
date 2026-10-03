import test from "node:test";
import assert from "node:assert/strict";
import {
  filterPostableFindings,
  parseRightSidePatchLines,
} from "../../src/domain/patch-lines.js";

test("right-side patch parsing tracks context/additions and ignores metadata/deletions", () => {
  assert.deepEqual([...parseRightSidePatchLines(null)], []);
  assert.deepEqual(
    [
      ...parseRightSidePatchLines(
        [
          "metadata before hunk",
          "@@ -1,2 +10,4 @@ heading",
          " context",
          "-deleted",
          "+added",
          "\\ No newline at end of file",
          "unexpected metadata",
          "+after metadata",
        ].join("\n"),
      ),
    ],
    [10, 11, 13],
  );
});

test("filterPostableFindings keeps right-side lines and drops the rest", () => {
  const files = [
    {
      path: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1,1 +1,2 @@\n context\n+added",
    },
  ];
  const kept = { path: "a.ts", line: 2, body: "x", severity: "low" as const };
  const offPatch = { ...kept, line: 9 };
  const otherFile = { ...kept, path: "b.ts" };
  assert.deepEqual(filterPostableFindings([kept, offPatch, otherFile], files), [
    kept,
  ]);
});
