import type { Check, CheckStatus, ChecksRollup } from "../types";

/** GitHub's own headline for each rollup, as T3 shows it. */
export const ROLLUP_LABELS: Record<Exclude<ChecksRollup, null>, string> = {
  passing: "All checks have passed",
  failing: "Some checks were not successful",
  pending: "Some checks haven't completed yet",
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  pending: "Running",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
};

/**
 * The rollup of a list of checks: any failure or cancellation fails it,
 * else any pending check keeps it pending, else one success passes it. No
 * checks, or only skipped and neutral ones, give null.
 */
export function checksRollup(checks: readonly Check[]): ChecksRollup {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((c) => c.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

/**
 * One row per check, not one per run of it. The newest run wins for each
 * (workflow, name) pair and holds the place where the pair first appeared.
 * When two survivors share a name, each reads `workflow / name`.
 */
export function dedupeChecks(checks: readonly Check[]): Check[] {
  const newest = new Map<string, Check>();
  for (const check of checks) {
    const key = `${check.workflowName ?? ""}\u0000${check.name}`;
    const kept = newest.get(key);
    if (!kept || isAtLeastAsNew(checkTime(check), checkTime(kept)))
      newest.set(key, check);
  }
  const survivors = [...newest.values()];
  const byName = new Map<string, number>();
  for (const c of survivors) byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
  return survivors.map((c) =>
    c.workflowName && (byName.get(c.name) ?? 0) > 1
      ? { ...c, name: `${c.workflowName} / ${c.name}` }
      : c,
  );
}

/** The workflow to show beside a check, unless its name already says it. */
export function checkWorkflowLabel(check: Check): string | null {
  const workflow = check.workflowName;
  if (!workflow || check.name.startsWith(`${workflow} / `)) return null;
  return workflow;
}

/** `2 of 9 failing`, `1 of 4 running`, or `All checks passed`. */
export function summarizeChecks(checks: readonly Check[]): string {
  if (checks.length === 0) return "No checks reported";
  const count = (...statuses: CheckStatus[]) =>
    checks.filter((c) => statuses.includes(c.status)).length;
  const failed = count("failure", "cancelled");
  const pending = count("pending");
  const passed = count("success");
  const total = checks.length;
  if (failed > 0) return `${failed} of ${total} failing`;
  if (pending > 0) return `${pending} of ${total} running`;
  return passed === total
    ? "All checks passed"
    : `${passed} of ${total} passing`;
}

/** Failures first, then running, then the rest, each in host order. */
export function sortChecks(checks: readonly Check[]): Check[] {
  const rank: Record<CheckStatus, number> = {
    failure: 0,
    cancelled: 0,
    pending: 1,
    success: 2,
    neutral: 3,
    skipped: 3,
  };
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank[a.c.status] - rank[b.c.status] || a.i - b.i)
    .map(({ c }) => c);
}

function checkTime(check: Check): string | null {
  return check.startedAt ?? check.completedAt;
}

/** ISO-8601 UTC timestamps compare correctly as text. */
function isAtLeastAsNew(
  candidate: string | null,
  kept: string | null,
): boolean {
  if (candidate === null) return kept === null;
  return kept === null || candidate >= kept;
}

const CHECKS_POLL_MS = 60_000;
const CHECKS_PENDING_POLL_MS = 30_000;

/**
 * Milliseconds between two reads of a session's checks: 30 s while they
 * run, 60 s otherwise, and none while the page is hidden.
 */
export function checksPollInterval(
  rollup: ChecksRollup | undefined,
  hidden: boolean,
): number | null {
  if (hidden) return null;
  return rollup === "pending" ? CHECKS_PENDING_POLL_MS : CHECKS_POLL_MS;
}
