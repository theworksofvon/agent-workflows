import { ReportInvalidError } from "./errors.js";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
  severity: ReviewSeverity;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

/** Severities accepted by the structured review result contract. */
export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export function parseReviewResult(output: string): ReviewResult {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new ReportInvalidError("Review agent produced no output.");
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new ReportInvalidError(
      `Review agent output was not valid JSON: ${String(err)}`,
      {
        cause: err,
      },
    );
  }

  if (!isRecord(value)) {
    throw new ReportInvalidError("Review result must be a JSON object.");
  }

  const summary = value.summary;
  const findings = value.findings;
  if (typeof summary !== "string") {
    throw new ReportInvalidError("Review result summary must be a string.");
  }
  if (!Array.isArray(findings)) {
    throw new ReportInvalidError("Review result findings must be an array.");
  }

  return {
    summary,
    findings: findings.map(normalizeFinding),
  };
}

export function findingFingerprint(finding: ReviewFinding): string {
  const normalizedBody = finding.body.trim().replace(/\s+/g, " ").toLowerCase();
  return `${finding.path}:${finding.line}:${finding.severity}:${normalizedBody}`;
}

function normalizeFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) {
    throw new ReportInvalidError("Each review finding must be an object.");
  }

  const { path, line, body, severity } = value;
  if (typeof path !== "string" || path.trim() === "") {
    throw new ReportInvalidError(
      "Review finding path must be a non-empty string.",
    );
  }
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new ReportInvalidError(
      "Review finding line must be an integer >= 1.",
    );
  }
  if (typeof body !== "string" || body.trim() === "") {
    throw new ReportInvalidError(
      "Review finding body must be a non-empty string.",
    );
  }
  if (
    typeof severity !== "string" ||
    !REVIEW_SEVERITIES.includes(severity as ReviewSeverity)
  ) {
    throw new ReportInvalidError(
      `Review finding severity must be one of: ${REVIEW_SEVERITIES.join(", ")}.`,
    );
  }

  return {
    path: path.trim(),
    line,
    body: body.trim(),
    severity: severity as ReviewSeverity,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Decision = "addressed" | "skipped" | "needs_human";
const DECISIONS: readonly Decision[] = ["addressed", "skipped", "needs_human"];

export interface CommentDecision {
  key: string;
  decision: Decision;
  reason?: string;
  note?: string;
}

export interface AgentReport {
  summary: string;
  comments: CommentDecision[];
}

export function parseAgentReport(
  text: string,
  expectedKeys: string[],
): AgentReport {
  const trimmed = text.trim();
  if (!trimmed) throw new ReportInvalidError("report is empty");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new ReportInvalidError(`report is not valid JSON: ${String(err)}`, {
      cause: err,
    });
  }
  if (!isRecord(value))
    throw new ReportInvalidError("report must be a JSON object");
  if (typeof value.summary !== "string" || value.summary.trim() === "")
    throw new ReportInvalidError("report summary must be a non-empty string");
  if (!Array.isArray(value.comments))
    throw new ReportInvalidError("report comments must be an array");

  const expected = new Set(expectedKeys);
  const seen = new Set<string>();
  const comments = value.comments.map((entry) =>
    normalizeDecision(entry, expected, seen),
  );
  for (const key of expectedKeys) {
    if (seen.has(key)) continue;
    comments.push({
      key,
      decision: "needs_human",
      reason: "no decision reported",
    });
  }
  return { summary: value.summary.trim(), comments };
}

export function countDecisions(report: AgentReport): Record<Decision, number> {
  const counts: Record<Decision, number> = {
    addressed: 0,
    skipped: 0,
    needs_human: 0,
  };
  for (const c of report.comments) counts[c.decision] += 1;
  return counts;
}

function normalizeDecision(
  entry: unknown,
  expected: Set<string>,
  seen: Set<string>,
): CommentDecision {
  if (!isRecord(entry))
    throw new ReportInvalidError("each comment decision must be an object");
  const { key, decision, reason, note } = entry;
  if (typeof key !== "string")
    throw new ReportInvalidError("decision key must be a string");
  if (!expected.has(key))
    throw new ReportInvalidError(`decision key "${key}" is not in this batch`);
  if (seen.has(key))
    throw new ReportInvalidError(
      `decision key "${key}" appears more than once`,
    );
  if (typeof decision !== "string" || !DECISIONS.includes(decision as Decision))
    throw new ReportInvalidError(
      `decision for "${key}" must be one of: ${DECISIONS.join(", ")}`,
    );
  const needsReason = decision !== "addressed";
  if (needsReason && (typeof reason !== "string" || reason.trim() === ""))
    throw new ReportInvalidError(
      `decision "${decision}" for "${key}" requires a reason`,
    );
  seen.add(key);
  return {
    key,
    decision: decision as Decision,
    ...(typeof reason === "string" && reason.trim() !== ""
      ? { reason: reason.trim() }
      : {}),
    ...(typeof note === "string" && note.trim() !== ""
      ? { note: note.trim() }
      : {}),
  };
}
