import type { ReviewFinding } from "./decisions.js";
import type { ReviewContext } from "./events.js";

export function filterPostableFindings(
  findings: ReviewFinding[],
  files: ReviewContext["files"],
): ReviewFinding[] {
  const postableLines = new Map<string, Set<number>>();
  for (const file of files) {
    postableLines.set(file.path, parseRightSidePatchLines(file.patch));
  }
  return findings.filter(
    (finding) => postableLines.get(finding.path)?.has(finding.line) ?? false,
  );
}

export function parseRightSidePatchLines(patch: string | null): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let rightLine: number | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      rightLine = Number(header[1]);
      continue;
    }
    if (rightLine === null) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      lines.add(rightLine);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("\\")) continue;
    rightLine += 1;
  }

  return lines;
}
