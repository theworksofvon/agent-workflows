import { describe, expect, it } from "vitest";
import { bodyExcerpt, runFinished, shortTime } from "./format";

describe("runFinished", () => {
  it("is true only for a ready or failed run", () => {
    expect(runFinished("ready")).toBe(true);
    expect(runFinished("failed")).toBe(true);
    for (const status of [
      "queued",
      "triaging",
      "preparing",
      "analyzing",
    ] as const)
      expect(runFinished(status)).toBe(false);
  });
});

describe("shortTime", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads minutes, hours, and days", () => {
    expect(shortTime(ago(20_000), now)).toBe("now");
    expect(shortTime(ago(5 * 60_000), now)).toBe("5m");
    expect(shortTime(ago(59 * 60_000), now)).toBe("59m");
    expect(shortTime(ago(2 * 3_600_000), now)).toBe("2h");
    expect(shortTime(ago(3 * 86_400_000), now)).toBe("3d");
  });

  it("falls back to a date after 30 days and to nothing for bad input", () => {
    expect(shortTime("2026-08-02T12:00:00Z", now)).toBe("Aug 2");
    expect(shortTime("not a date", now)).toBe("");
  });
});

describe("bodyExcerpt", () => {
  it("drops HTML comments and tags and keeps the text", () => {
    expect(
      bodyExcerpt("<!-- template -->Fixes <b>bug</b>\n<script>alert(1)</script>ok"),
    ).toBe("Fixes bug\nalert(1)ok");
  });

  it("collapses blank lines and cuts long text with an ellipsis", () => {
    expect(bodyExcerpt("a\n\n\n\n\nb")).toBe("a\n\nb");
    const cut = bodyExcerpt("x".repeat(700), 600);
    expect(cut).toHaveLength(601);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("gives an empty string for no body", () => {
    expect(bodyExcerpt(null)).toBe("");
  });
});
