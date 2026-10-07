import { describe, expect, it } from "vitest";
import {
  buildCrumbs,
  chapterIndexOf,
  chapterProgressLabel,
  nextCurrentFile,
} from "./orientation";

const BASE = { owner: "ek", repo: "pluto", prNumber: 8 };

describe("buildCrumbs", () => {
  it("names the repository, pull request, and tab on the overview", () => {
    const crumbs = buildCrumbs({
      ...BASE,
      tab: "overview",
      chapter: { index: 1, title: "Ingest" },
      file: "app/a.py",
    });
    expect(crumbs.map((c) => c.label)).toEqual(["pluto", "#8", "Overview"]);
    expect(crumbs[0]!.title).toBe("ek/pluto");
  });

  it("adds the numbered chapter and the current file name on the guide", () => {
    const crumbs = buildCrumbs({
      ...BASE,
      tab: "guide",
      chapter: { index: 1, title: "Ingest" },
      file: "app/data/jobs.py",
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "pluto",
      "#8",
      "Guide",
      "02 · Ingest",
      "jobs.py",
    ]);
    expect(crumbs[4]!.title).toBe("app/data/jobs.py");
  });

  it("has no chapter on the diff tab and no file until one is on screen", () => {
    const crumbs = buildCrumbs({
      ...BASE,
      tab: "diff",
      chapter: { index: 0, title: "x" },
      file: null,
    });
    expect(crumbs.map((c) => c.kind)).toEqual(["repo", "pr", "tab"]);
  });
});

describe("chapter position", () => {
  it("labels the position and the reviewed count", () => {
    expect(chapterProgressLabel(1, 6, 3)).toBe("Chapter 2 of 6 · 3 reviewed");
  });

  it("falls back to the first chapter for an unknown id", () => {
    const chapters = [{ id: "c1" }, { id: "c2" }];
    expect(chapterIndexOf(chapters, "c2")).toBe(1);
    expect(chapterIndexOf(chapters, "nope")).toBe(0);
    expect(chapterIndexOf(chapters, null)).toBe(0);
  });
});

describe("nextCurrentFile", () => {
  const paths = ["a", "b", "c"];

  it("makes an entering file current", () => {
    expect(
      nextCurrentFile(paths, "a", { path: "b", entering: true, below: false }),
    ).toBe("b");
  });

  it("keeps the current file when it scrolls off the top", () => {
    expect(
      nextCurrentFile(paths, "b", { path: "b", entering: false, below: false }),
    ).toBe("b");
  });

  it("steps back a file when the reader scrolls up past the current top", () => {
    expect(
      nextCurrentFile(paths, "b", { path: "b", entering: false, below: true }),
    ).toBe("a");
    expect(
      nextCurrentFile(paths, "a", { path: "a", entering: false, below: true }),
    ).toBeNull();
  });

  it("ignores a file that is not current leaving the line", () => {
    expect(
      nextCurrentFile(paths, "c", { path: "b", entering: false, below: true }),
    ).toBe("c");
  });
});
