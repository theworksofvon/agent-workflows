import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKER_TAG,
  commentKey,
  dropReason,
  groupKeyFor,
  isRetryableAgentFailure,
} from "../../src/domain/batching.js";
import type { Comment } from "../../src/domain/events.js";

const base: Comment = {
  key: "k",
  id: 1,
  kind: "issue",
  author: "alice",
  body: "hi",
  createdAt: "2026-01-01T00:00:00Z",
};

test("commentKey is stable", () => {
  assert.equal(
    commentKey({ owner: "o", repo: "r" }, 4, "review", 9),
    "o/r#4:review:9",
  );
});

test("groupKeyFor groups review comments by review id", () => {
  assert.equal(
    groupKeyFor(4, { ...base, kind: "review", reviewId: 7 }),
    "pr:4:review:7",
  );
  assert.equal(
    groupKeyFor(4, { ...base, kind: "review", reviewId: null }),
    "pr:4:review-comments",
  );
  assert.equal(groupKeyFor(4, base), "pr:4:conversation");
  assert.equal(
    groupKeyFor(4, { ...base, kind: "review_summary" }),
    "pr:4:conversation",
  );
});

test("dropReason applies self, bot, and allowlist rules", () => {
  const open = { allowedAuthors: null, agentSelfUser: null };
  assert.equal(dropReason(base, open), null);
  assert.equal(dropReason({ ...base, body: `${MARKER_TAG} x` }, open), "self");
  assert.equal(
    dropReason(
      { ...base, author: "Bot-User" },
      { ...open, agentSelfUser: "bot-user" },
    ),
    "self",
  );
  assert.equal(dropReason({ ...base, author: "dependabot[bot]" }, open), "bot");
  assert.equal(
    dropReason(base, { ...open, allowedAuthors: ["Bob"] }),
    "author-not-allowed",
  );
  assert.equal(dropReason(base, { ...open, allowedAuthors: ["ALICE"] }), null);
});

test("isRetryableAgentFailure matches quota signatures", () => {
  assert.equal(isRetryableAgentFailure("HTTP 429 Too Many Requests"), true);
  assert.equal(isRetryableAgentFailure("syntax error"), false);
});
