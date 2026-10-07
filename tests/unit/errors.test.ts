import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainError,
  DraftPullRequestError,
  ReportInvalidError,
  ReportMissingError,
} from "../../src/domain/errors.js";

test("DomainError names itself and passes cause through ErrorOptions", () => {
  const cause = new Error("root");
  const error = new DomainError("wrapped", { cause });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "DomainError");
  assert.equal(error.message, "wrapped");
  assert.equal(error.cause, cause);
});

test("ReportMissingError carries the missing report path", () => {
  const error = new ReportMissingError("/tmp/report.json");
  assert.ok(error instanceof DomainError);
  assert.equal(error.name, "ReportMissingError");
  assert.equal(error.message, "agent produced no report at /tmp/report.json");
  assert.equal(error.path, "/tmp/report.json");
});

test("ReportInvalidError keeps its own name and message", () => {
  const invalid = new ReportInvalidError("bad report");
  assert.ok(invalid instanceof DomainError);
  assert.equal(invalid.name, "ReportInvalidError");
  assert.equal(invalid.message, "bad report");
});

test("DraftPullRequestError explains that review mode needs a ready PR", () => {
  const error = new DraftPullRequestError("owner/repo#7");
  assert.ok(error instanceof DomainError);
  assert.equal(error.name, "DraftPullRequestError");
  assert.equal(
    error.message,
    "PR owner/repo#7 is a draft; review mode only runs on ready-for-review PRs.",
  );
});
