import type { ReviewContext } from "./pull-request.js";

export function filterPostableFindings<
  T extends { path: string; line: number },
>(findings: T[], files: ReviewContext["files"]): T[] {
  const isPostable = postableLinePredicate(files);
  return findings.filter((finding) => isPostable(finding));
}

/** Whether `{ path, line }` is a right-side line that appears in the PR diff. */
export function postableLinePredicate(
  files: ReviewContext["files"],
): (target: { path: string; line: number }) => boolean {
  const postableLines = new Map<string, Set<number>>();
  for (const file of files) {
    postableLines.set(file.path, parseRightSidePatchLines(file.patch));
  }
  return (target) => postableLines.get(target.path)?.has(target.line) ?? false;
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
