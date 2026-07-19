import type { ReviewAdversarialMode } from "../../config.js";
import type { PullRequestReviewContext, ReviewResult } from "./types.js";

export interface AdversarialDecision {
  run: boolean;
  reasons: string[];
}

const SENSITIVE_PATH =
  /(^|\/)(auth|security|crypto|payment|billing|permission|migration|migrations|schema|database|db)(\/|\.|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.github\/workflows\/)/i;

export function decideAdversarialReview(
  mode: ReviewAdversarialMode,
  ctx: PullRequestReviewContext,
  primary: ReviewResult,
): AdversarialDecision {
  if (mode === "off") return { run: false, reasons: ["disabled"] };
  if (mode === "always") return { run: true, reasons: ["configured-always"] };

  const reasons: string[] = [];
  const changedLines = ctx.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  if (ctx.files.length >= 12) reasons.push(`many-files:${ctx.files.length}`);
  if (changedLines >= 400) reasons.push(`large-diff:${changedLines}`);
  if (ctx.files.some((file) => SENSITIVE_PATH.test(file.path)))
    reasons.push("sensitive-path");
  if (ctx.files.some((file) => file.patch === null))
    reasons.push("missing-patch");
  if (
    primary.findings.some(
      (finding) =>
        finding.severity === "critical" || finding.severity === "high",
    )
  ) {
    reasons.push("high-severity-primary-finding");
  }

  return {
    run: reasons.length > 0,
    reasons: reasons.length > 0 ? reasons : ["low-risk"],
  };
}
