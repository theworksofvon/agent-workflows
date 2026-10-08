import { pad2, splitPath } from "./format";
import type { SessionTab } from "./route";

export type CrumbKind = "repo" | "pr" | "tab" | "chapter" | "file";

export interface Crumb {
  kind: CrumbKind;
  label: string;
  /** The full text when the label is shortened. */
  title?: string;
}

export const TAB_LABELS: Record<SessionTab, string> = {
  overview: "Overview",
  guide: "Guide",
  diff: "Diff",
};

/** `repo / #n / Tab [/ NN · chapter] [/ file]` */
export function buildCrumbs(input: {
  owner: string;
  repo: string;
  prNumber: number;
  tab: SessionTab;
  chapter?: { index: number; title: string } | null;
  file?: string | null;
}): Crumb[] {
  const crumbs: Crumb[] = [
    { kind: "repo", label: input.repo, title: `${input.owner}/${input.repo}` },
    { kind: "pr", label: `#${input.prNumber}` },
    { kind: "tab", label: TAB_LABELS[input.tab] },
  ];
  if (input.tab === "guide" && input.chapter)
    crumbs.push({
      kind: "chapter",
      label: `${pad2(input.chapter.index + 1)} · ${input.chapter.title}`,
    });
  if (input.tab !== "overview" && input.file)
    crumbs.push({
      kind: "file",
      label: splitPath(input.file).name,
      title: input.file,
    });
  return crumbs;
}

/** `Chapter 2 of 6 · 3 reviewed` */
export function chapterProgressLabel(
  index: number,
  total: number,
  reviewed: number,
): string {
  return `Chapter ${index + 1} of ${total} · ${reviewed} reviewed`;
}

/** The chapter the route names, or the first chapter. */
export function chapterIndexOf(
  chapters: readonly { id: string }[],
  id: string | null,
): number {
  return Math.max(
    0,
    chapters.findIndex((c) => c.id === id),
  );
}

/**
 * The file at the top of the viewport after one file crosses the reading
 * line. A file that enters the line becomes current. When the current file
 * leaves the line downward (the reader scrolled up past its top), the file
 * before it becomes current, or none for the first file. A file that leaves
 * upward keeps the current file until the next one enters.
 */
export function nextCurrentFile(
  paths: readonly string[],
  current: string | null,
  change: { path: string; entering: boolean; below: boolean },
): string | null {
  if (change.entering) return change.path;
  if (change.path !== current || !change.below) return current;
  const index = paths.indexOf(change.path);
  return index > 0 ? paths[index - 1]! : null;
}
