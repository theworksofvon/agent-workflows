import type { SessionStatus, SessionSummary } from "../types";
import { plural } from "./format";

export type StatusTone = "ready" | "running" | "failed";

/** Case-insensitive match on `owner/repo`, `#number`, and the title. */
export function matchesQuery(s: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = `${repoName(s)} #${s.prNumber} ${s.title ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

export function statusTone(status: SessionStatus): StatusTone {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "running";
}

/**
 * The second line of a sidebar row: the stage while a run works, else
 * `depth · findings · chapters`. `reviewed` is the count of reviewed
 * chapters when the page knows it.
 */
export function sessionSubtitle(s: SessionSummary, reviewed?: number): string {
  const tone = statusTone(s.status);
  if (tone === "running") return s.stage || s.status;
  if (tone === "failed") return s.stage ? `Failed · ${s.stage}` : "Failed";
  const parts: string[] = [];
  if (s.triage) parts.push(s.triage.depth);
  parts.push(plural(s.counts.findings, "finding"));
  if (s.counts.chapters > 0)
    parts.push(
      reviewed === undefined
        ? plural(s.counts.chapters, "chapter")
        : `${reviewed}/${s.counts.chapters} chapters`,
    );
  return parts.join(" · ");
}

export function repoName(s: { repo: { owner: string; repo: string } }): string {
  return `${s.repo.owner}/${s.repo.repo}`;
}

/** `owner/repo#number`, the identity of a pull request across its runs. */
export function pullKey(s: {
  repo: { owner: string; repo: string };
  prNumber?: number;
  number?: number;
}): string {
  return `${repoName(s).toLowerCase()}#${s.prNumber ?? s.number}`;
}

/** When a run started. Older servers send no `createdAt`. */
export function runTime(s: SessionSummary): string {
  return s.createdAt ?? s.updatedAt;
}

/**
 * One session per pull request: its latest run, by start time. The rows
 * keep the order of the input list.
 */
export function latestRunPerPull(
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const latest = new Map<string, SessionSummary>();
  for (const s of sessions) {
    const kept = latest.get(pullKey(s));
    if (!kept || runTime(s) > runTime(kept)) latest.set(pullKey(s), s);
  }
  const keep = new Set(latest.values());
  return sessions.filter((s) => keep.has(s));
}

export interface RunPosition {
  /** Every run of the pull request, oldest first. */
  runs: SessionSummary[];
  /** The 0-based place of the session in `runs`, or -1. */
  index: number;
}

/** The runs of the pull request that `sessionId` belongs to. */
export function runsOf(
  sessions: readonly SessionSummary[],
  sessionId: string,
): RunPosition {
  const self = sessions.find((s) => s.id === sessionId);
  if (!self) return { runs: [], index: -1 };
  const key = pullKey(self);
  const runs = sessions
    .filter((s) => pullKey(s) === key)
    .sort((a, b) => runTime(a).localeCompare(runTime(b)));
  return { runs, index: runs.findIndex((s) => s.id === sessionId) };
}

/** The latest run of a pull request, if it has one. */
export function latestRunOf(
  sessions: readonly SessionSummary[] | null,
  pull: { repo: { owner: string; repo: string }; number: number },
): SessionSummary | null {
  let latest: SessionSummary | null = null;
  const key = pullKey(pull);
  for (const s of sessions ?? [])
    if (pullKey(s) === key && (!latest || runTime(s) > runTime(latest)))
      latest = s;
  return latest;
}
