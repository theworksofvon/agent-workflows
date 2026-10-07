import { describe, expect, it } from "vitest";
import type { InboxGroup, InboxPull } from "../types";
import {
  filterInbox,
  findPull,
  inboxNotices,
} from "./inbox";

function pull(
  repo: string,
  number: number,
  groups: InboxGroup[],
  updatedAt: string,
  title = `PR ${number}`,
): InboxPull {
  const [owner, name] = repo.split("/") as [string, string];
  return {
    repo: { owner, repo: name },
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    author: { login: "octo", avatarUrl: null },
    headRef: "feat",
    baseRef: "main",
    state: "open",
    reviewDecision: null,
    updatedAt,
    lastCommit: null,
    checks: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    groups,
    sessionId: null,
  };
}

const PULLS = [
  pull("ek/pluto", 14, ["reviewRequested"], "2026-10-07T10:00:00Z", "Ledger"),
  pull("ek/pluto", 12, ["authored"], "2026-10-07T12:00:00Z", "SSE odds"),
  pull("me/dotfiles", 3, ["reviewRequested"], "2026-10-07T11:00:00Z"),
  pull("Ek/homelab", 2, ["involved"], "2026-10-06T09:00:00Z"),
];

describe("inbox", () => {
  it("filters by group, repository, and query, newest first", () => {
    const requested = { group: "reviewRequested" as const, repo: null, query: "" };
    expect(filterInbox(PULLS, requested).map((p) => p.number)).toEqual([3, 14]);
    expect(
      filterInbox(PULLS, { ...requested, repo: "ek/pluto" }).map(
        (p) => p.number,
      ),
    ).toEqual([14]);
    expect(
      filterInbox(PULLS, { ...requested, query: "ledger" }).map(
        (p) => p.number,
      ),
    ).toEqual([14]);
    expect(filterInbox(PULLS, { ...requested, query: "#3" })).toHaveLength(1);
  });

  it("finds a pull by owner, repo, and number without regard to case", () => {
    expect(findPull(PULLS, "ek", "HOMELAB", 2)?.number).toBe(2);
    expect(findPull(PULLS, "ek", "pluto", 99)).toBeNull();
    expect(findPull(null, "ek", "pluto", 14)).toBeNull();
  });
});

describe("inboxNotices", () => {
  it("reads truncation for the chosen group only", () => {
    const inbox = { truncated: { authored: true, involved: false } };
    expect(inboxNotices(inbox, "authored").truncated).toBe(true);
    expect(inboxNotices(inbox, "involved").truncated).toBe(false);
    expect(inboxNotices(inbox, "reviewRequested").truncated).toBe(false);
  });

  it("passes warnings and the stale flag, and copes with an older server", () => {
    expect(
      inboxNotices({ warnings: ["rate limit low", " "], stale: true }, "authored"),
    ).toEqual({ truncated: false, warnings: ["rate limit low"], stale: true });
    expect(inboxNotices(null, "authored")).toEqual({
      truncated: false,
      warnings: [],
      stale: false,
    });
  });
});
