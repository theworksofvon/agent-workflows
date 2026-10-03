import test from "node:test";
import assert from "node:assert/strict";
import type { PullRequest } from "../../src/domain/events.js";
import { normalizeDelivery } from "../../src/domain/webhook.js";

const repository = { name: "r", owner: { login: "o" } };
const repo = { owner: "o", repo: "r" };

function rawPr(over: Record<string, unknown> = {}) {
  return {
    number: 4,
    title: "T",
    body: null,
    draft: false,
    head: { ref: "f", repo: { full_name: "o/r" } },
    base: { ref: "main", repo: { full_name: "o/r" } },
    ...over,
  };
}

const pr: PullRequest = {
  repo,
  number: 4,
  title: "T",
  body: null,
  headRef: "f",
  baseRef: "main",
  draft: false,
  fromFork: false,
};

function reviewComment(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    user: { login: "alice" },
    body: "fix",
    created_at: "2026-01-01T00:00:00Z",
    path: "a.ts",
    line: 3,
    original_line: 2,
    diff_hunk: "@@",
    pull_request_review_id: 9,
    ...over,
  };
}

function issueComment(over: Record<string, unknown> = {}) {
  return {
    action: "created",
    repository,
    issue: { number: 4, pull_request: { url: "u" } },
    comment: {
      id: 7,
      user: { login: "bob" },
      body: "please fix",
      created_at: "2026-01-02T00:00:00Z",
    },
    ...over,
  };
}

function review(over: Record<string, unknown> = {}) {
  return {
    action: "submitted",
    repository,
    review: {
      id: 11,
      user: { login: "carol" },
      body: "overall, tidy this",
      submitted_at: "2026-01-03T00:00:00Z",
    },
    pull_request: rawPr(),
    ...over,
  };
}

test("an unknown event name is ignored as unsupported", () => {
  assert.deepEqual(normalizeDelivery("push", { repository }), {
    kind: "ignored",
    reason: "unsupported-event",
  });
});

test("a payload without a full repository is ignored", () => {
  for (const payload of [
    null,
    "x",
    {},
    { repository: { name: "r" } },
    { repository: { name: "r", owner: {} } },
  ]) {
    assert.deepEqual(normalizeDelivery("pull_request", payload), {
      kind: "ignored",
      reason: "missing-repository",
    });
  }
});

test("issue_comment on a plain issue is ignored", () => {
  const result = normalizeDelivery(
    "issue_comment",
    issueComment({ issue: { number: 4 } }),
  );
  assert.deepEqual(result, { kind: "ignored", reason: "not-a-pull-request" });
});

test("issue_comment on a PR needs the PR and builds an issue comment", () => {
  const result = normalizeDelivery("issue_comment", issueComment());
  assert.equal(result.kind, "needs_pull_request");
  if (result.kind !== "needs_pull_request") return;
  assert.equal(result.prNumber, 4);
  assert.deepEqual(result.repo, repo);
  assert.deepEqual(result.build(pr), [
    {
      kind: "comment",
      pr,
      comment: {
        key: "o/r#4:issue:7",
        id: 7,
        kind: "issue",
        author: "bob",
        body: "please fix",
        createdAt: "2026-01-02T00:00:00Z",
      },
    },
  ]);
});

test("comment events whose action is not created are ignored", () => {
  assert.deepEqual(
    normalizeDelivery("issue_comment", issueComment({ action: "edited" })),
    { kind: "ignored", reason: "uninteresting-action" },
  );
  assert.deepEqual(
    normalizeDelivery("pull_request_review_comment", {
      action: "deleted",
      repository,
      comment: reviewComment(),
      pull_request: rawPr(),
    }),
    { kind: "ignored", reason: "uninteresting-action" },
  );
});

test("pull_request_review_comment created becomes a review comment event", () => {
  const result = normalizeDelivery("pull_request_review_comment", {
    action: "created",
    repository,
    comment: reviewComment(),
    pull_request: rawPr(),
  });
  assert.equal(result.kind, "events");
  if (result.kind !== "events") return;
  assert.deepEqual(result.events, [
    {
      kind: "comment",
      pr,
      comment: {
        key: "o/r#4:review:5",
        id: 5,
        kind: "review",
        author: "alice",
        body: "fix",
        createdAt: "2026-01-01T00:00:00Z",
        reviewId: 9,
        review: { path: "a.ts", line: 3, diffHunk: "@@" },
      },
    },
  ]);
});

test("a review comment on an outdated line falls back to original_line", () => {
  const result = normalizeDelivery("pull_request_review_comment", {
    action: "created",
    repository,
    comment: reviewComment({ line: null, pull_request_review_id: null }),
    pull_request: rawPr(),
  });
  if (result.kind !== "events") return assert.fail(result.kind);
  const [event] = result.events;
  if (event.kind !== "comment") return assert.fail(event.kind);
  assert.deepEqual(event.comment.review, {
    path: "a.ts",
    line: 2,
    diffHunk: "@@",
  });
  assert.equal(event.comment.reviewId, null);
});

test("a comment without a user is attributed to unknown", () => {
  const result = normalizeDelivery("pull_request_review_comment", {
    action: "created",
    repository,
    comment: reviewComment({ user: null }),
    pull_request: rawPr(),
  });
  if (result.kind !== "events") return assert.fail(result.kind);
  const [event] = result.events;
  if (event.kind !== "comment") return assert.fail(event.kind);
  assert.equal(event.comment.author, "unknown");
});

test("a submitted review with a body becomes a review_summary comment", () => {
  const result = normalizeDelivery("pull_request_review", review());
  assert.deepEqual(result, {
    kind: "events",
    events: [
      {
        kind: "comment",
        pr,
        comment: {
          key: "o/r#4:review_summary:11",
          id: 11,
          kind: "review_summary",
          author: "carol",
          body: "overall, tidy this",
          createdAt: "2026-01-03T00:00:00Z",
        },
      },
    ],
  });
});

test("a submitted review with an empty or null body is ignored", () => {
  for (const body of ["", null]) {
    const payload = review();
    assert.deepEqual(
      normalizeDelivery("pull_request_review", {
        ...payload,
        review: { ...payload.review, body },
      }),
      { kind: "ignored", reason: "empty-review-body" },
    );
  }
});

test("a review that is not submitted is ignored", () => {
  assert.deepEqual(
    normalizeDelivery("pull_request_review", review({ action: "dismissed" })),
    { kind: "ignored", reason: "uninteresting-action" },
  );
});

test("pull_request opened and ready_for_review mark the PR ready", () => {
  for (const action of ["opened", "ready_for_review"]) {
    assert.deepEqual(
      normalizeDelivery("pull_request", {
        action,
        repository,
        pull_request: rawPr(),
      }),
      { kind: "events", events: [{ kind: "pull_request_ready", pr }] },
    );
  }
});

test("pull_request closed is ignored", () => {
  assert.deepEqual(
    normalizeDelivery("pull_request", {
      action: "closed",
      repository,
      pull_request: rawPr(),
    }),
    { kind: "ignored", reason: "uninteresting-action" },
  );
});

test("events on a draft PR are ignored", () => {
  assert.deepEqual(
    normalizeDelivery("pull_request", {
      action: "opened",
      repository,
      pull_request: rawPr({ draft: true }),
    }),
    { kind: "ignored", reason: "draft" },
  );
  assert.deepEqual(
    normalizeDelivery(
      "pull_request_review",
      review({ pull_request: rawPr({ draft: true }) }),
    ),
    { kind: "ignored", reason: "draft" },
  );
});

test("events on a fork PR are ignored, including a deleted head repo", () => {
  for (const headRepo of [{ full_name: "mallory/r" }, null]) {
    assert.deepEqual(
      normalizeDelivery("pull_request_review_comment", {
        action: "created",
        repository,
        comment: reviewComment(),
        pull_request: rawPr({ head: { ref: "f", repo: headRepo } }),
      }),
      { kind: "ignored", reason: "fork" },
    );
  }
});

test("payloads missing or mistyping a field the events need are malformed", () => {
  const issueCase = issueComment();
  const reviewCase = review();
  const cases: Array<[string, unknown]> = [
    ["issue_comment", { ...issueCase, issue: undefined }],
    ["issue_comment", { ...issueCase, comment: { id: 7 } }],
    [
      "pull_request_review_comment",
      { action: "created", repository, comment: reviewComment() },
    ],
    [
      "pull_request_review_comment",
      {
        action: "created",
        repository,
        comment: reviewComment({ path: undefined }),
        pull_request: rawPr(),
      },
    ],
    [
      "pull_request_review_comment",
      {
        action: "created",
        repository,
        comment: reviewComment({ id: "5" }),
        pull_request: rawPr(),
      },
    ],
    [
      "pull_request",
      {
        action: "opened",
        repository,
        pull_request: rawPr({ head: undefined }),
      },
    ],
    ["pull_request_review", { ...reviewCase, review: undefined }],
    [
      "pull_request",
      { action: "opened", repository, pull_request: rawPr({ title: 4 }) },
    ],
  ];
  for (const [event, payload] of cases) {
    assert.deepEqual(normalizeDelivery(event, payload), {
      kind: "ignored",
      reason: "malformed-payload",
    });
  }
});

test("a repo the resolver rejects is not watched; a resolved repo keys events", () => {
  const payload = { action: "opened", repository, pull_request: rawPr() };
  assert.deepEqual(
    normalizeDelivery("pull_request", payload, () => null),
    { kind: "ignored", reason: "repo-not-watched" },
  );
  const canonical = { owner: "O", repo: "R" };
  assert.deepEqual(
    normalizeDelivery("pull_request", payload, () => canonical),
    {
      kind: "events",
      events: [{ kind: "pull_request_ready", pr: { ...pr, repo: canonical } }],
    },
  );
});
