import type { PRReviewTarget } from "./types.js";

const SLUG_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/;

export function parseReviewTarget(raw: string): PRReviewTarget {
  const value = raw.trim();
  const match = SLUG_PATTERN.exec(value) ?? URL_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `Invalid PR target "${raw}". Expected owner/repo#123 or https://github.com/owner/repo/pull/123.`,
    );
  }

  return {
    repo: {
      owner: match[1],
      repo: match[2],
    },
    prNumber: Number(match[3]),
  };
}
