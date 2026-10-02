import test from "node:test";
import assert from "node:assert/strict";
import {
  countDecisions,
  parseAgentReport,
} from "../../src/domain/decisions.js";
import { ReportInvalidError } from "../../src/domain/errors.js";

const keys = ["k1", "k2", "k3"];

test("parses a complete report", () => {
  const report = parseAgentReport(
    JSON.stringify({
      summary: "did things",
      comments: [
        { key: "k1", decision: "addressed" },
        { key: "k2", decision: "skipped", reason: "already done" },
        { key: "k3", decision: "needs_human", reason: "conflicts" },
      ],
    }),
    keys,
  );
  assert.equal(report.comments.length, 3);
  assert.deepEqual(countDecisions(report), {
    addressed: 1,
    skipped: 1,
    needs_human: 1,
  });
});

test("fills missing keys as needs_human", () => {
  const report = parseAgentReport(
    JSON.stringify({
      summary: "s",
      comments: [{ key: "k1", decision: "addressed" }],
    }),
    keys,
  );
  const missing = report.comments.filter((c) => c.key !== "k1");
  assert.deepEqual(
    missing.map((c) => [c.key, c.decision, c.reason]),
    [
      ["k2", "needs_human", "no decision reported"],
      ["k3", "needs_human", "no decision reported"],
    ],
  );
});

test("includes optional note field", () => {
  const report = parseAgentReport(
    JSON.stringify({
      summary: "s",
      comments: [{ key: "k1", decision: "addressed", note: "extra context" }],
    }),
    keys,
  );
  assert.equal(report.comments[0].note, "extra context");
});

for (const [label, body] of [
  ["not json", "nope"],
  ["not object", "[]"],
  ["empty summary", JSON.stringify({ summary: "", comments: [] })],
  ["comments not array", JSON.stringify({ summary: "s", comments: {} })],
  ["entry not object", JSON.stringify({ summary: "s", comments: [1] })],
  [
    "bad decision",
    JSON.stringify({
      summary: "s",
      comments: [{ key: "k1", decision: "maybe" }],
    }),
  ],
  [
    "skipped without reason",
    JSON.stringify({
      summary: "s",
      comments: [{ key: "k1", decision: "skipped" }],
    }),
  ],
  [
    "unknown key",
    JSON.stringify({
      summary: "s",
      comments: [{ key: "zz", decision: "addressed" }],
    }),
  ],
  [
    "duplicate key",
    JSON.stringify({
      summary: "s",
      comments: [
        { key: "k1", decision: "addressed" },
        { key: "k1", decision: "addressed" },
      ],
    }),
  ],
  [
    "key not string",
    JSON.stringify({
      summary: "s",
      comments: [{ key: 1, decision: "addressed" }],
    }),
  ],
] as const) {
  test(`rejects ${label}`, () => {
    assert.throws(() => parseAgentReport(body, keys), ReportInvalidError);
  });
}

test("empty text is invalid", () => {
  assert.throws(() => parseAgentReport("   ", keys), ReportInvalidError);
});
