import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../types";
import {
  latestRunOf,
  latestRunPerPull,
  runsOf,
  sessionSubtitle,
} from "./sessions";

function summary(
  id: string,
  repo: string,
  prNumber: number,
  title: string,
  extra: Partial<SessionSummary> = {},
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
    updatedAt: "2026-10-07T12:00:00Z",
    counts: { files: 3, findings: 2, chapters: 6 },
    account: "octo",
    authorAvatarUrl: null,
    state: "open",
    reviewedChapters: 0,
    ...extra,
  };
}

describe("sessionSubtitle", () => {
  it("shows the stage while a run works", () => {
    const s = summary("x", "ek/pluto", 1, "t", {
      status: "analyzing",
      stage: "Writing the guide",
    });
    expect(sessionSubtitle(s)).toBe("Writing the guide");
  });

  it("shows depth, findings, and reviewed chapters when known", () => {
    const s = summary("x", "ek/pluto", 1, "t", {
      triage: {
        depth: "deep",
        needsGuide: true,
        risk: 3,
        engine: "heuristic",
        confidence: null,
        reasons: [],
        probabilities: null,
      },
    });
    expect(sessionSubtitle(s, 3)).toBe("deep · 2 findings · 3/6 chapters");
    expect(sessionSubtitle(s)).toBe("deep · 2 findings · 6 chapters");
  });
});

describe("runs of a pull request", () => {
  const first = summary("r1", "ek/pluto", 14, "Ledger", {
    updatedAt: "2026-10-07T09:00:00Z",
  });
  const second = summary("r2", "ek/pluto", 14, "Ledger", {
    updatedAt: "2026-10-07T11:00:00Z",
  });
  const other = summary("o", "ek/pluto", 8, "Other");
  const list = [second, other, first];

  it("keeps one row per pull request: the latest run", () => {
    expect(latestRunPerPull(list).map((s) => s.id)).toEqual(["r2", "o"]);
  });

  it("numbers the runs oldest first", () => {
    expect(runsOf(list, "r1")).toEqual({ runs: [first, second], index: 0 });
    expect(runsOf(list, "r2").index).toBe(1);
    expect(runsOf(list, "o").runs).toEqual([other]);
    expect(runsOf(list, "missing")).toEqual({ runs: [], index: -1 });
  });

  it("finds the latest run of an inbox pull", () => {
    const ref = { repo: { owner: "EK", repo: "Pluto" }, number: 14 };
    expect(latestRunOf(list, ref)?.id).toBe("r2");
    expect(latestRunOf(list, { ...ref, number: 1 })).toBeNull();
    expect(latestRunOf(null, ref)).toBeNull();
  });
});

describe("run order by start time", () => {
  // Publishing the old run touched it last: updatedAt is newer, createdAt is not.
  const old = summary("old", "ek/pluto", 14, "Ledger", {
    createdAt: "2026-10-07T09:00:00Z",
    updatedAt: "2026-10-07T15:00:00Z",
  });
  const fresh = summary("fresh", "ek/pluto", 14, "Ledger", {
    createdAt: "2026-10-07T11:00:00Z",
    updatedAt: "2026-10-07T11:05:00Z",
  });
  const list = [old, fresh];

  it("picks the latest run by createdAt, not updatedAt", () => {
    expect(latestRunPerPull(list).map((s) => s.id)).toEqual(["fresh"]);
    expect(
      latestRunOf(list, { repo: { owner: "ek", repo: "pluto" }, number: 14 })
        ?.id,
    ).toBe("fresh");
    expect(runsOf(list, "old").runs.map((s) => s.id)).toEqual(["old", "fresh"]);
  });

  it("falls back to updatedAt when a server sends no createdAt", () => {
    const a = summary("a", "ek/pluto", 1, "t", { updatedAt: "2026-10-07T09:00:00Z" });
    const b = summary("b", "ek/pluto", 1, "t", { updatedAt: "2026-10-07T10:00:00Z" });
    expect(latestRunPerPull([a, b]).map((s) => s.id)).toEqual(["b"]);
  });
});
