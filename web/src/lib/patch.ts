export type LineKind = "add" | "del" | "ctx";

export interface PatchLine {
  kind: LineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: PatchLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a GitHub unified-diff patch (the `patch` field of a PR file). */
export function parsePatch(patch: string | null): Hunk[] {
  if (!patch) return [];
  const raw = patch.split("\n");
  // A patch that ends with a newline leaves one empty string after split.
  if (raw[raw.length - 1] === "") raw.pop();

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = {
        header: line,
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;

    const marker = line[0];
    if (marker === "+") {
      current.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    } else if (marker === "-") {
      current.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else {
      // " " context, or a bare empty line from a tool that trimmed it.
      current.lines.push({
        kind: "ctx",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }
  return hunks;
}

/** New-side line numbers present in the patch; only these accept comments. */
export function newSideLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) lines.add(line.newLine);
    }
  }
  return lines;
}

/** New-side line numbers of the lines after the first `limit` patch lines. */
export function newLinesPast(hunks: Hunk[], limit: number): Set<number> {
  const past = new Set<number>();
  let index = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (index >= limit && line.newLine !== null) past.add(line.newLine);
      index += 1;
    }
  }
  return past;
}
