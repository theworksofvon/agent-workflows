import test from "node:test";
import assert from "node:assert/strict";
import {
  checksRollup,
  dedupeChecks,
  INBOX_QUERIES,
  mergeInbox,
  pullState,
  reviewDecision,
  toCheckStatus,
  type Check,
} from "../../src/domain/inbox.js";
import { card } from "../fakes/github.js";

test("check runs and commit statuses map to one status the way T3 Code maps them", () => {
  const cases: Array<[Parameters<typeof toCheckStatus>[0], string]> = [
    [{ status: "IN_PROGRESS", conclusion: null }, "pending"],
    [{ status: "QUEUED" }, "pending"],
    [{ status: "COMPLETED", conclusion: "SUCCESS" }, "success"],
    [{ status: "completed", conclusion: " failure " }, "failure"],
    [{ status: "COMPLETED", conclusion: "TIMED_OUT" }, "failure"],
    [{ status: "COMPLETED", conclusion: "STARTUP_FAILURE" }, "failure"],
    [{ status: "COMPLETED", conclusion: "ACTION_REQUIRED" }, "failure"],
    [{ status: "COMPLETED", conclusion: "CANCELLED" }, "cancelled"],
    [{ status: "COMPLETED", conclusion: "SKIPPED" }, "skipped"],
    [{ status: "COMPLETED", conclusion: "NEUTRAL" }, "neutral"],
    [{ status: "COMPLETED", conclusion: "STALE" }, "neutral"],
    [{ status: "", state: "SUCCESS" }, "success"],
    [{ state: "ERROR" }, "failure"],
    [{ state: "PENDING" }, "pending"],
    [{ state: "EXPECTED" }, "pending"],
    [{}, "neutral"],
  ];
  for (const [raw, expected] of cases)
    assert.equal(toCheckStatus(raw), expected, JSON.stringify(raw));
});

test("the rollup puts a failure before a pending check and needs a verdict to pass", () => {
  assert.equal(checksRollup([]), null);
  assert.equal(checksRollup(["skipped", "neutral"]), null);
  assert.equal(checksRollup(["success", "skipped"]), "passing");
  assert.equal(checksRollup(["success", "pending"]), "pending");
  assert.equal(checksRollup(["pending", "failure"]), "failing");
  assert.equal(checksRollup(["success", "cancelled"]), "failing");
});

function check(overrides: Partial<Check>): Check {
  return {
    name: "test",
    workflowName: "CI",
    status: "success",
    url: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

test("dedupe keeps the newest run of each check in the place it first appeared", () => {
  const old = check({ status: "failure", completedAt: "2026-10-07T01:00:00Z" });
  const lint = check({ name: "lint" });
  const rerun = check({ status: "pending", startedAt: "2026-10-07T02:00:00Z" });
  const otherWorkflow = check({ workflowName: "Nightly" });
  const status = check({ name: "deploy", workflowName: null });
  assert.deepEqual(dedupeChecks([old, lint, rerun, otherWorkflow, status]), [
    rerun,
    lint,
    otherWorkflow,
    status,
  ]);

  // An older run that arrives later does not replace the newer one.
  assert.deepEqual(dedupeChecks([rerun, old]), [rerun]);
  // A run with no time loses to a timed one, and a tie goes to the later.
  const untimed = check({ status: "neutral" });
  assert.deepEqual(dedupeChecks([old, untimed]), [old]);
  assert.deepEqual(dedupeChecks([untimed, old]), [old]);
  const untimedAgain = check({ status: "skipped" });
  assert.deepEqual(dedupeChecks([untimed, untimedAgain]), [untimedAgain]);
});

test("pull state and review decision map GitHub's enums", () => {
  assert.equal(pullState("MERGED", false), "merged");
  assert.equal(pullState("CLOSED", true), "closed");
  assert.equal(pullState("OPEN", true), "draft");
  assert.equal(pullState("OPEN", false), "open");
  assert.equal(reviewDecision("APPROVED"), "approved");
  assert.equal(reviewDecision("CHANGES_REQUESTED"), "changes_requested");
  assert.equal(reviewDecision("REVIEW_REQUIRED"), "review_required");
  assert.equal(reviewDecision(null), null);
  assert.equal(reviewDecision(undefined), null);
});

test("the inbox queries match the contract", () => {
  assert.deepEqual(INBOX_QUERIES, {
    reviewRequested:
      "is:pr is:open archived:false review-requested:@me sort:updated-desc",
    authored: "is:pr is:open archived:false author:@me sort:updated-desc",
    involved:
      "is:pr is:open archived:false involves:@me -author:@me -review-requested:@me sort:updated-desc",
  });
});

test("merging puts one row per PR with every group, newest update first", () => {
  const a = card({ number: 1, updatedAt: "2026-10-07T01:00:00Z" });
  const b = card({ number: 2, updatedAt: "2026-10-07T03:00:00Z" });
  const otherRepo = card({
    repo: { owner: "acme", repo: "gadgets" },
    number: 1,
    updatedAt: "2026-10-07T02:00:00Z",
  });
  const rows = mergeInbox({
    reviewRequested: [a],
    authored: [b, a],
    involved: [otherRepo, otherRepo],
  });
  assert.deepEqual(
    rows.map((r) => [r.repo.repo, r.number, r.groups, r.sessionId]),
    [
      ["widgets", 2, ["authored"], null],
      ["gadgets", 1, ["involved"], null],
      ["widgets", 1, ["reviewRequested", "authored"], null],
    ],
  );
});
