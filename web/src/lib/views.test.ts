import { describe, expect, it } from "vitest";
import type { InboxGroup, InboxPull, SessionSummary } from "../types";
import {
  formatCount,
  keepRepo,
  parseView,
  viewCounts,
  viewForRepo,
  viewRepos,
  viewRows,
} from "./views";

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

function session(
  id: string,
  repo: string,
  prNumber: number,
  createdAt: string,
  title = `PR ${prNumber}`,
): SessionSummary {
  const [owner, name] = repo.split("/") as [string, string];
  return {
    id,
    repo: { owner, repo: name },
    prNumber,
    title,
    author: "octo",
    status: "ready",
    stage: "Ready",
    triage: null,
    createdAt,
    updatedAt: createdAt,
    counts: { files: 3, findings: 2, chapters: 6 },
    account: "octo",
    authorAvatarUrl: null,
    state: "open",
    reviewedChapters: 0,
  };
}

const PULLS = [
  pull("ek/pluto", 14, ["reviewRequested"], "2026-10-07T10:00:00Z", "Ledger"),
  pull("ek/pluto", 12, ["authored"], "2026-10-07T12:00:00Z", "SSE odds"),
  pull("me/dotfiles", 3, ["reviewRequested"], "2026-10-07T11:00:00Z"),
  pull("ek/pluto", 9, ["reviewRequested", "involved"], "2026-10-05T09:00:00Z"),
];

const SESSIONS = [
  session("new", "ek/pluto", 14, "2026-10-07T12:00:00Z", "Ledger"),
  session("hl", "ek/homelab", 2, "2026-10-06T12:00:00Z", "Agent cloud"),
  session("old", "ek/pluto", 14, "2026-10-01T12:00:00Z", "Ledger"),
];

describe("parseView", () => {
  it("keeps a saved view and falls back to the first view", () => {
    expect(parseView("guided", true)).toBe("guided");
    expect(parseView("authored", true)).toBe("authored");
    expect(parseView("bogus", true)).toBe("reviewRequested");
    expect(parseView(null, true)).toBe("reviewRequested");
  });

  it("shows only the guided reviews on a server without an inbox", () => {
    expect(parseView("authored", false)).toBe("guided");
  });
});

describe("viewCounts", () => {
  it("is null for each view until its data loads, never 0", () => {
    expect(viewCounts(null, null)).toEqual({
      reviewRequested: null,
      authored: null,
      involved: null,
      guided: null,
    });
    expect(formatCount(null)).toBe("–");
  });

  it("counts pulls per group and one guided review per pull request", () => {
    expect(viewCounts(PULLS, SESSIONS)).toEqual({
      reviewRequested: 3,
      authored: 1,
      involved: 1,
      guided: 2,
    });
    expect(viewCounts([], null).authored).toBe(0);
    expect(formatCount(0)).toBe("0");
  });
});

describe("viewRows", () => {
  const all = { repo: null, query: "" };

  it("groups an inbox view by repository, newest pull first", () => {
    const rows = viewRows("reviewRequested", PULLS, SESSIONS, all);
    if (rows.kind !== "pulls") throw new Error("expected pulls");
    expect(
      rows.groups.map((g) => [g.repo, g.items.map((p) => p.number)]),
    ).toEqual([
      ["me/dotfiles", [3]],
      ["ek/pluto", [14, 9]],
    ]);
  });

  it("groups the guided reviews by repository, latest run per pull", () => {
    const rows = viewRows("guided", PULLS, SESSIONS, all);
    if (rows.kind !== "sessions") throw new Error("expected sessions");
    expect(rows.groups.map((g) => [g.repo, g.items.map((s) => s.id)])).toEqual([
      ["ek/pluto", ["new"]],
      ["ek/homelab", ["hl"]],
    ]);
  });

  it("applies the repo filter and the search, and drops empty groups", () => {
    expect(
      viewRows("reviewRequested", PULLS, null, { repo: "ek/pluto", query: "" })
        .groups,
    ).toHaveLength(1);
    expect(
      viewRows("guided", null, SESSIONS, { repo: null, query: "agent" }).groups,
    ).toEqual([{ repo: "ek/homelab", items: [SESSIONS[1]] }]);
    expect(
      viewRows("authored", PULLS, null, { repo: null, query: "nothing" })
        .groups,
    ).toEqual([]);
  });

  it("is empty while the data of the view loads", () => {
    expect(viewRows("involved", null, null, all).groups).toEqual([]);
  });
});

describe("repositories of a view", () => {
  it("lists the repositories of the chosen view only", () => {
    expect(viewRepos("reviewRequested", PULLS, SESSIONS)).toEqual([
      "ek/pluto",
      "me/dotfiles",
    ]);
    expect(viewRepos("authored", PULLS, SESSIONS)).toEqual(["ek/pluto"]);
    expect(viewRepos("guided", PULLS, SESSIONS)).toEqual([
      "ek/homelab",
      "ek/pluto",
    ]);
  });

  it("drops a repo filter that the view does not show", () => {
    expect(keepRepo(["ek/pluto"], "ek/pluto")).toBe("ek/pluto");
    expect(keepRepo(["ek/pluto"], "me/dotfiles")).toBeNull();
  });

  it("finds a view that shows a repository, current view first", () => {
    expect(viewForRepo("authored", PULLS, SESSIONS, "EK/pluto", true)).toBe(
      "authored",
    );
    expect(viewForRepo("authored", PULLS, SESSIONS, "ek/homelab", true)).toBe(
      "guided",
    );
    expect(viewForRepo("guided", PULLS, SESSIONS, "me/dotfiles", true)).toBe(
      "reviewRequested",
    );
    expect(viewForRepo("guided", PULLS, SESSIONS, "me/dotfiles", false)).toBe(
      "guided",
    );
    expect(viewForRepo("involved", PULLS, SESSIONS, "gone/repo", true)).toBe(
      "involved",
    );
  });
});
