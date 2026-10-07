import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewContext } from "../../src/domain/pull-request.js";
import { heuristicTriage } from "../../src/domain/triage.js";

function ctxOf(
  files: Array<[string, number, number]>,
  over: Partial<ReviewContext> = {},
): ReviewContext {
  return {
    repo: { owner: "o", repo: "r" },
    prNumber: 1,
    title: "t",
    body: "b",
    headRef: "h",
    baseRef: "main",
    files: files.map(([path, additions, deletions]) => ({
      path,
      status: "modified",
      additions,
      deletions,
      patch: null,
    })),
    ...over,
  };
}

function manyFiles(n: number, path = "src/a"): Array<[string, number, number]> {
  return Array.from({ length: n }, (_, i) => [`${path}${i}.ts`, 1, 1]);
}

test("heuristicTriage picks skip for generated or docs-only changes", () => {
  const t = heuristicTriage(
    ctxOf([
      ["pnpm-lock.yaml", 900, 10],
      ["README.md", 1, 1],
    ]),
  );
  assert.equal(t.depth, "skip");
  assert.equal(t.risk, 0);
  assert.deepEqual(t.reasons, ["generated-only"]);
  assert.equal(t.engine, "heuristic");
  assert.equal(t.confidence, null);
  assert.equal(t.probabilities, null);
  assert.equal(t.needsGuide, true);
});

test("heuristicTriage does not skip an empty change", () => {
  assert.equal(heuristicTriage(ctxOf([])).depth, "light");
});

test("heuristicTriage picks light for a small change", () => {
  const t = heuristicTriage(ctxOf([["src/a.ts", 5, 5]]));
  assert.equal(t.depth, "light");
  assert.equal(t.risk, 1);
  assert.equal(t.needsGuide, false);
  assert.deepEqual(t.reasons, ["small-change"]);
});

test("heuristicTriage picks standard for many files or a larger diff", () => {
  const files = heuristicTriage(ctxOf(manyFiles(6)));
  assert.equal(files.depth, "standard");
  assert.equal(files.risk, 2);
  assert.deepEqual(files.reasons, ["many-files:6"]);
  const lines = heuristicTriage(ctxOf([["src/a.ts", 100, 50]]));
  assert.equal(lines.depth, "standard");
  assert.deepEqual(lines.reasons, ["large-diff:150"]);
  assert.equal(lines.needsGuide, false);
});

test("heuristicTriage picks deep for sensitive paths, many files, or huge diffs", () => {
  const sensitive = heuristicTriage(ctxOf([["src/auth/login.ts", 1, 1]]));
  assert.equal(sensitive.depth, "deep");
  assert.equal(sensitive.risk, 4);
  assert.deepEqual(sensitive.reasons, ["sensitive-path"]);
  const wide = heuristicTriage(ctxOf(manyFiles(25)));
  assert.equal(wide.depth, "deep");
  assert.equal(wide.risk, 3);
  assert.equal(wide.needsGuide, true);
  const huge = heuristicTriage(ctxOf([["src/a.ts", 700, 100]]));
  assert.equal(huge.depth, "deep");
  assert.deepEqual(huge.reasons, ["large-diff:800"]);
});
