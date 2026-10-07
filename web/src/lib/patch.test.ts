import { describe, expect, it } from "vitest";
import { newLinesPast, parsePatch } from "./patch";

describe("parsePatch", () => {
  it("returns no hunks for an empty or null patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch(null)).toEqual([]);
  });

  it("numbers context, deleted, and added lines on each side", () => {
    const hunks = parsePatch(
      [
        "@@ -10,4 +10,5 @@ function load() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " return a;",
        " }",
      ].join("\n"),
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe("@@ -10,4 +10,5 @@ function load() {");
    expect(hunks[0]!.oldStart).toBe(10);
    expect(hunks[0]!.newStart).toBe(10);
    expect(hunks[0]!.lines).toEqual([
      { kind: "ctx", text: "const a = 1;", oldLine: 10, newLine: 10 },
      { kind: "del", text: "const b = 2;", oldLine: 11, newLine: null },
      { kind: "add", text: "const b = 3;", oldLine: null, newLine: 11 },
      { kind: "add", text: "const c = 4;", oldLine: null, newLine: 12 },
      { kind: "ctx", text: "return a;", oldLine: 12, newLine: 13 },
      { kind: "ctx", text: "}", oldLine: 13, newLine: 14 },
    ]);
  });

  it("restarts numbering at each hunk header", () => {
    const hunks = parsePatch(
      [
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " same",
        "@@ -40 +40,2 @@ tail",
        " keep",
        "+added",
      ].join("\n"),
    );

    expect(hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
      [1, 1],
      [40, 40],
    ]);
    expect(hunks[1]!.lines).toEqual([
      { kind: "ctx", text: "keep", oldLine: 40, newLine: 40 },
      { kind: "add", text: "added", oldLine: null, newLine: 41 },
    ]);
  });

  it("drops the no-newline marker without shifting line numbers", () => {
    const hunks = parsePatch(
      [
        "@@ -1 +1 @@",
        "-before",
        "\\ No newline at end of file",
        "+after",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );

    expect(hunks[0]!.lines).toEqual([
      { kind: "del", text: "before", oldLine: 1, newLine: null },
      { kind: "add", text: "after", oldLine: null, newLine: 1 },
    ]);
  });

  it("reads a new file hunk that starts at zero on the old side", () => {
    const hunks = parsePatch("@@ -0,0 +1,2 @@\n+one\n+two\n");

    expect(hunks[0]!.oldStart).toBe(0);
    expect(hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("treats a bare empty line inside a hunk as context", () => {
    const hunks = parsePatch("@@ -1,3 +1,3 @@\n a\n\n b");

    expect(hunks[0]!.lines).toEqual([
      { kind: "ctx", text: "a", oldLine: 1, newLine: 1 },
      { kind: "ctx", text: "", oldLine: 2, newLine: 2 },
      { kind: "ctx", text: "b", oldLine: 3, newLine: 3 },
    ]);
  });

  it("ignores text before the first hunk header", () => {
    const hunks = parsePatch("diff --git a/x b/x\n@@ -1 +1 @@\n-x\n+y");

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toHaveLength(2);
  });
});

describe("newLinesPast", () => {
  it("lists new-side lines after the limit across hunks", () => {
    const hunks = parsePatch(
      "@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9,1 +9,2 @@\n x\n+y",
    );

    expect([...newLinesPast(hunks, 2)]).toEqual([2, 9, 10]);
    expect(newLinesPast(hunks, 99).size).toBe(0);
  });
});
