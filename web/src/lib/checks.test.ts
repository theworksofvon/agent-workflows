import { describe, expect, it } from "vitest";
import type { Check, CheckStatus } from "../types";
import {
  checksPollInterval,
  checksRollup,
  checkWorkflowLabel,
  dedupeChecks,
  sortChecks,
  summarizeChecks,
} from "./checks";

function check(
  name: string,
  status: CheckStatus,
  extra: Partial<Check> = {},
): Check {
  return {
    name,
    workflowName: "CI",
    status,
    url: null,
    startedAt: "2026-10-07T10:00:00Z",
    completedAt: null,
    ...extra,
  };
}

describe("checksRollup", () => {
  it("is null without checks or with only skipped and neutral ones", () => {
    expect(checksRollup([])).toBeNull();
    expect(
      checksRollup([check("a", "skipped"), check("b", "neutral")]),
    ).toBeNull();
  });

  it("fails on any failure or cancellation, even while others run", () => {
    expect(
      checksRollup([check("a", "pending"), check("b", "cancelled")]),
    ).toBe("failing");
    expect(checksRollup([check("a", "success"), check("b", "failure")])).toBe(
      "failing",
    );
  });

  it("is pending while a check runs, else passing on a success", () => {
    expect(checksRollup([check("a", "success"), check("b", "pending")])).toBe(
      "pending",
    );
    expect(checksRollup([check("a", "success"), check("b", "skipped")])).toBe(
      "passing",
    );
  });
});

describe("dedupeChecks", () => {
  it("keeps the newest run of each check in its first place", () => {
    const old = check("test", "failure", { startedAt: "2026-10-07T09:00:00Z" });
    const lint = check("lint", "success");
    const rerun = check("test", "pending", {
      startedAt: "2026-10-07T11:00:00Z",
    });
    expect(dedupeChecks([old, lint, rerun])).toEqual([rerun, lint]);
  });

  it("prefers a run with a time over one without", () => {
    const untimed = check("test", "failure", { startedAt: null });
    const timed = check("test", "success");
    expect(dedupeChecks([timed, untimed])).toEqual([timed]);
  });

  it("names checks that share a name across workflows as workflow / name", () => {
    const ci = check("build", "success");
    const release = check("build", "failure", { workflowName: "Release" });
    const bare = check("build", "success", { workflowName: null });
    expect(dedupeChecks([ci, release, bare]).map((c) => c.name)).toEqual([
      "CI / build",
      "Release / build",
      "build",
    ]);
  });
});

describe("check labels", () => {
  it("shows the workflow beside a check unless the name holds it", () => {
    expect(checkWorkflowLabel(check("lint", "success"))).toBe("CI");
    expect(checkWorkflowLabel(check("CI / build", "success"))).toBeNull();
    expect(
      checkWorkflowLabel(check("vercel", "success", { workflowName: null })),
    ).toBeNull();
  });

  it("summarizes failures first, then running, then passes", () => {
    expect(summarizeChecks([])).toBe("No checks reported");
    expect(
      summarizeChecks([check("a", "failure"), check("b", "pending")]),
    ).toBe("1 of 2 failing");
    expect(
      summarizeChecks([check("a", "success"), check("b", "pending")]),
    ).toBe("1 of 2 running");
    expect(summarizeChecks([check("a", "success")])).toBe("All checks passed");
    expect(
      summarizeChecks([check("a", "success"), check("b", "skipped")]),
    ).toBe("1 of 2 passing");
  });

  it("sorts failures, then running checks, and keeps host order inside", () => {
    const list = [
      check("a", "success"),
      check("b", "pending"),
      check("c", "failure"),
      check("d", "skipped"),
      check("e", "cancelled"),
    ];
    expect(sortChecks(list).map((c) => c.name)).toEqual([
      "c",
      "e",
      "b",
      "a",
      "d",
    ]);
  });
});

describe("checksPollInterval", () => {
  it("polls every 30 s while checks run and every 60 s otherwise", () => {
    expect(checksPollInterval("pending", false)).toBe(30_000);
    expect(checksPollInterval("passing", false)).toBe(60_000);
    expect(checksPollInterval(null, false)).toBe(60_000);
    expect(checksPollInterval(undefined, false)).toBe(60_000);
  });

  it("stops while the page is hidden", () => {
    expect(checksPollInterval("pending", true)).toBeNull();
    expect(checksPollInterval("passing", true)).toBeNull();
  });
});
