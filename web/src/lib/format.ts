import type { ChapterRole, ReviewSeverity, SessionStatus } from "../types";

export const SEVERITY_ORDER: readonly ReviewSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

/** Roles whose chapters a reader can skim. */
export const LOW_SIGNAL_ROLES: ReadonlySet<ChapterRole> = new Set([
  "tests",
  "docs",
  "generated",
]);

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** The compact age a list row shows: `now`, `5m`, `2h`, `3d`, `Oct 2`. */
export function shortTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function fileAnchor(path: string): string {
  return `file-${path.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

export function findingAnchor(findingId: string): string {
  return `finding-${findingId}`;
}

/** A run can start again only once the current one has finished. */
export function runFinished(status: SessionStatus): boolean {
  return status === "ready" || status === "failed";
}

export const RERUN_CONFIRM =
  "Start a new run? Your verdicts and comments carry over where they still apply.";

/**
 * The first `max` characters of a pull request description as plain text:
 * HTML comments and tags are dropped, runs of blank lines collapse, and a
 * cut ends in an ellipsis. React escapes the result when it renders.
 */
export function bodyExcerpt(body: string | null | undefined, max = 600): string {
  const text = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}
