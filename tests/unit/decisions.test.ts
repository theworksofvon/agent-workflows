import test from "node:test";
import assert from "node:assert/strict";
import { findingId } from "../../src/domain/decisions.js";

test("findingId is a stable 12-char hex id that follows the body", () => {
  const finding = {
    path: "a.ts",
    line: 3,
    body: "Null deref",
    severity: "high" as const,
  };
  const id = findingId(finding);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(findingId({ ...finding }), id);
  assert.equal(findingId({ ...finding, body: "  null   DEREF " }), id);
  assert.notEqual(findingId({ ...finding, body: "Something else" }), id);
});
