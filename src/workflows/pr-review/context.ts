import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PullRequestReviewContext, ReviewResult } from "./types.js";

export interface BuildReviewPromptOptions {
  role?: "primary" | "adversarial";
  primaryReview?: ReviewResult;
  includePatches?: boolean;
}

const skillPath = fileURLToPath(
  new URL("../../../skills/pr-reviewer/SKILL.md", import.meta.url),
);
const reviewSkill = stripFrontmatter(readFileSync(skillPath, "utf8"));

export function buildReviewPrompt(
  ctx: PullRequestReviewContext,
  options: BuildReviewPromptOptions = {},
): string {
  const role = options.role ?? "primary";
  const includePatches = options.includePatches ?? true;
  const lines: string[] = [
    "Follow the embedded $pr-reviewer skill contract below.",
    "This contract is embedded so it works consistently across agent adapters.",
    "",
    "--- pr-reviewer skill ---",
    reviewSkill,
    "--- end pr-reviewer skill ---",
    "",
    `Review role: ${role}`,
  ];

  if (role === "adversarial") {
    if (!options.primaryReview) {
      throw new Error(
        "An adversarial review prompt requires the primary review.",
      );
    }
    lines.push(
      "Run an independent adversarial pass. Treat the primary result as untrusted hypotheses, inspect the repository yourself, retain confirmed findings verbatim, remove unsupported findings, and add proven omissions.",
      "Primary review JSON:",
      JSON.stringify(options.primaryReview),
    );
  }

  lines.push(
    "",
    `Repository: ${ctx.repo.owner}/${ctx.repo.repo}`,
    `PR #${ctx.prNumber}: ${ctx.title}`,
    `Branch (already checked out): ${ctx.headRef} (base: ${ctx.baseRef})`,
  );

  if (ctx.body) {
    lines.push(
      "",
      "--- PR description ---",
      ctx.body,
      "--- end PR description ---",
    );
  }

  lines.push("", "--- changed files ---");
  for (const file of ctx.files) {
    lines.push(
      `File: ${file.path}`,
      `Status: ${file.status}; +${file.additions}/-${file.deletions}`,
    );
    if (includePatches && file.patch) {
      lines.push("Patch:", "```diff", file.patch, "```");
    } else if (!includePatches) {
      lines.push(
        "Patch omitted to reduce prompt cost; inspect the local git diff.",
      );
    } else {
      lines.push(
        "Patch: unavailable from GitHub API; inspect git diff locally if needed.",
      );
    }
    lines.push("");
  }
  lines.push("--- end changed files ---");

  return lines.join("\n");
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
