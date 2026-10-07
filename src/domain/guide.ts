import { ReportInvalidError } from "./errors.js";
import { isRecord } from "./util.js";

export type ChapterRole =
  "core" | "supporting" | "config" | "data" | "tests" | "docs" | "generated";

/** Display order of chapters; earlier roles come first. */
export const CHAPTER_ROLE_ORDER: readonly ChapterRole[] = [
  "core",
  "supporting",
  "config",
  "data",
  "tests",
  "docs",
  "generated",
];

export type FlowNodeChange = "added" | "changed" | "removed" | "unchanged";
const FLOW_NODE_CHANGES: readonly FlowNodeChange[] = [
  "added",
  "changed",
  "removed",
  "unchanged",
];

export interface FlowNode {
  label: string;
  change: FlowNodeChange;
  chapter: string | null;
}

export interface Flow {
  title: string;
  caption: string;
  before: FlowNode[];
  after: FlowNode[];
}

export interface GuideOverview {
  context: string;
  steps: string[];
  flows: Flow[];
}

export interface GuideChapter {
  id: string;
  title: string;
  role: ChapterRole;
  summary: string;
  files: string[];
}

export interface Guide {
  overview: GuideOverview;
  chapters: GuideChapter[];
}

export const OTHER_CHAPTER_ID = "other";

/** Validates the guide JSON an agent wrote and normalizes it against the PR's changed paths. */
export function parseGuide(
  text: string,
  changedPaths: readonly string[],
): Guide {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (err) {
    throw new ReportInvalidError(`guide is not valid JSON: ${String(err)}`, {
      cause: err,
    });
  }
  if (!isRecord(value))
    throw new ReportInvalidError("guide must be a JSON object");
  const { overview, chapters } = value;
  if (!isRecord(overview))
    throw new ReportInvalidError("guide overview must be an object");
  const context = nonEmpty(overview.context, "overview context");
  if (!Array.isArray(overview.steps))
    throw new ReportInvalidError("overview steps must be an array");
  const steps = overview.steps.map((step) => nonEmpty(step, "overview step"));
  if (overview.flows !== undefined && !Array.isArray(overview.flows))
    throw new ReportInvalidError("overview flows must be an array");
  const rawFlows: unknown[] = overview.flows ?? [];
  if (!Array.isArray(chapters) || chapters.length === 0)
    throw new ReportInvalidError("guide chapters must be a non-empty array");

  const seenIds = new Set<string>();
  const parsed = chapters.map((chapter) => normalizeChapter(chapter, seenIds));
  const aliases = reservedIdAliases(seenIds);
  const normalized = placeFiles(
    parsed.map((chapter) => ({
      ...chapter,
      id: aliases.get(chapter.id) ?? chapter.id,
    })),
    changedPaths,
  );
  const ids = new Set(normalized.map((chapter) => chapter.id));
  return {
    overview: {
      context,
      steps,
      flows: rawFlows.map((flow) => normalizeFlow(flow, ids, aliases)),
    },
    chapters: normalized,
  };
}

/**
 * The catch-all chapter owns OTHER_CHAPTER_ID, so an agent chapter with that
 * id moves to the first free "other-N" id, and flows follow it there.
 */
function reservedIdAliases(seenIds: Set<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!seenIds.has(OTHER_CHAPTER_ID)) return aliases;
  let n = 1;
  while (seenIds.has(`${OTHER_CHAPTER_ID}-${n}`)) n += 1;
  aliases.set(OTHER_CHAPTER_ID, `${OTHER_CHAPTER_ID}-${n}`);
  return aliases;
}

/** Drops unknown and repeated paths, sorts by role, and appends the catch-all chapter. */
function placeFiles(
  chapters: GuideChapter[],
  changedPaths: readonly string[],
): GuideChapter[] {
  const changed = new Set(changedPaths);
  const placed = new Set<string>();
  const kept: GuideChapter[] = [];
  for (const chapter of chapters) {
    const files = chapter.files.filter((file) => {
      if (!changed.has(file) || placed.has(file)) return false;
      placed.add(file);
      return true;
    });
    if (files.length > 0) kept.push({ ...chapter, files });
  }
  kept.sort(
    (a, b) =>
      CHAPTER_ROLE_ORDER.indexOf(a.role) - CHAPTER_ROLE_ORDER.indexOf(b.role),
  );
  const rest = changedPaths.filter((path) => !placed.has(path));
  if (rest.length > 0) {
    kept.push({
      id: OTHER_CHAPTER_ID,
      title: "Other changes",
      role: "supporting",
      summary: "Files the guide did not place in a chapter.",
      files: rest,
    });
  }
  return kept;
}

function normalizeChapter(value: unknown, seenIds: Set<string>): GuideChapter {
  if (!isRecord(value))
    throw new ReportInvalidError("each guide chapter must be an object");
  const id = nonEmpty(value.id, "chapter id");
  if (seenIds.has(id))
    throw new ReportInvalidError(`chapter id "${id}" appears more than once`);
  seenIds.add(id);
  const title = nonEmpty(value.title, `chapter "${id}" title`);
  const { role, summary, files } = value;
  if (typeof summary !== "string")
    throw new ReportInvalidError(`chapter "${id}" summary must be a string`);
  if (!Array.isArray(files))
    throw new ReportInvalidError(`chapter "${id}" files must be an array`);
  return {
    id,
    title,
    role: CHAPTER_ROLE_ORDER.includes(role as ChapterRole)
      ? (role as ChapterRole)
      : "supporting",
    summary: summary.trim(),
    files: files.map((file) => {
      if (typeof file !== "string")
        throw new ReportInvalidError(
          `chapter "${id}" files must all be strings`,
        );
      return file.trim();
    }),
  };
}

function normalizeFlow(
  value: unknown,
  chapterIds: Set<string>,
  aliases: Map<string, string>,
): Flow {
  if (!isRecord(value))
    throw new ReportInvalidError("each overview flow must be an object");
  const title = nonEmpty(value.title, "flow title");
  if (value.caption !== undefined && typeof value.caption !== "string")
    throw new ReportInvalidError("flow caption must be a string");
  return {
    title,
    caption: (value.caption ?? "").trim(),
    before: normalizeNodes(value.before, "before", chapterIds, aliases),
    after: normalizeNodes(value.after, "after", chapterIds, aliases),
  };
}

function normalizeNodes(
  value: unknown,
  side: string,
  chapterIds: Set<string>,
  aliases: Map<string, string>,
): FlowNode[] {
  if (!Array.isArray(value))
    throw new ReportInvalidError(`flow ${side} must be an array`);
  return value.map((node) => {
    if (!isRecord(node))
      throw new ReportInvalidError(`each flow ${side} node must be an object`);
    const label = nonEmpty(node.label, `flow ${side} node label`);
    const raw = typeof node.chapter === "string" ? node.chapter.trim() : null;
    const chapter = raw === null ? null : (aliases.get(raw) ?? raw);
    return {
      label,
      change: FLOW_NODE_CHANGES.includes(node.change as FlowNodeChange)
        ? (node.change as FlowNodeChange)
        : "changed",
      chapter: chapter !== null && chapterIds.has(chapter) ? chapter : null,
    };
  });
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function nonEmpty(value: unknown, what: string): string {
  const text = trimmed(value);
  if (text === null || text === "")
    throw new ReportInvalidError(`${what} must be a non-empty string`);
  return text;
}
