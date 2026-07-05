import type { ReviewFinding, ReviewResult, ReviewSeverity } from "./types.js";

const SEVERITIES: readonly ReviewSeverity[] = ["critical", "high", "medium", "low"];

export function parseReviewResult(output: string): ReviewResult {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Review agent produced no output.");
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Review agent output was not valid JSON: ${String(err)}`);
  }

  if (!isRecord(value)) {
    throw new Error("Review result must be a JSON object.");
  }

  const summary = value.summary;
  const findings = value.findings;
  if (typeof summary !== "string") {
    throw new Error("Review result summary must be a string.");
  }
  if (!Array.isArray(findings)) {
    throw new Error("Review result findings must be an array.");
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
    throw new Error("Each review finding must be an object.");
  }

  const { path, line, body, severity } = value;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("Review finding path must be a non-empty string.");
  }
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error("Review finding line must be an integer >= 1.");
  }
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("Review finding body must be a non-empty string.");
  }
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as ReviewSeverity)) {
    throw new Error(`Review finding severity must be one of: ${SEVERITIES.join(", ")}.`);
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
