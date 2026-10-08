import type { ReviewContext } from "./pull-request.js";
import { SENSITIVE_PATH } from "./risk.js";

export type ReviewDepth = "skip" | "light" | "standard" | "deep";

/**
 * A run's triage. New runs set engine "heuristic" with no confidence or
 * probabilities; sessions stored by older versions can hold a model's.
 */
export interface Triage {
  depth: ReviewDepth;
  needsGuide: boolean;
  risk: number;
  engine: string;
  confidence: number | null;
  reasons: string[];
  probabilities: Record<string, Record<string, number>> | null;
}

const GENERATED_PATH =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.lock|.*\.min\.(js|css)|.*\.snap|dist\/.*|.*\.generated\.\w+)$/i;
const DOC_PATH = /\.(md|mdx|txt)$/i;

/** Rules over the PR metadata: file count, diff size, and sensitive paths. */
export function heuristicTriage(ctx: ReviewContext): Triage {
  const files = ctx.files.length;
  const lines = sum(ctx, "additions") + sum(ctx, "deletions");
  const sensitive = ctx.files.some((f) => SENSITIVE_PATH.test(f.path));
  const generatedOnly =
    files > 0 &&
    ctx.files.every(
      (f) => GENERATED_PATH.test(f.path) || DOC_PATH.test(f.path),
    );
  const reasons: string[] = [];
  if (files >= 6) reasons.push(`many-files:${files}`);
  if (lines >= 150) reasons.push(`large-diff:${lines}`);
  if (sensitive) reasons.push("sensitive-path");

  let depth: ReviewDepth;
  if (generatedOnly) {
    depth = "skip";
    reasons.length = 0;
    reasons.push("generated-only");
  } else if (sensitive || files >= 25 || lines >= 800) {
    depth = "deep";
  } else if (files >= 6 || lines >= 150) {
    depth = "standard";
  } else {
    depth = "light";
    reasons.push("small-change");
  }
  const base = { skip: 0, light: 1, standard: 2, deep: 3 }[depth];
  return {
    depth,
    needsGuide: files >= 8 || lines >= 300,
    risk: Math.min(4, base + (depth === "deep" && sensitive ? 1 : 0)),
    engine: "heuristic",
    confidence: null,
    reasons,
    probabilities: null,
  };
}

function sum(ctx: ReviewContext, key: "additions" | "deletions"): number {
  return ctx.files.reduce((total, f) => total + f[key], 0);
}
