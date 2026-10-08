import { createHash } from "node:crypto";
import { ReportInvalidError } from "./errors.js";
import { isRecord } from "./util.js";

/**
 * Marker tag embedded in every review this app posts. An HTML comment is
 * invisible in the rendered PR but easy to search for.
 */
export const MARKER_TAG = "<!-- agent-workflows:bot -->";

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

/** Short stable id for a finding; follows the fingerprint, so it survives whitespace and case edits. */
export function findingId(finding: ReviewFinding): string {
  return createHash("sha1")
    .update(findingFingerprint(finding))
    .digest("hex")
    .slice(0, 12);
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
