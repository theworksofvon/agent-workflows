import type { ReviewResult } from "../domain/decisions.js";
import type { ReviewContext } from "../domain/pull-request.js";

export interface BuildReviewPromptOptions {
  role?: "primary" | "adversarial";
  primaryReview?: ReviewResult;
  includePatches?: boolean;
}

export function buildReviewPrompt(
  ctx: ReviewContext,
  reportPath: string,
  options: BuildReviewPromptOptions = {},
): string {
  const role = options.role ?? "primary";
  const includePatches = options.includePatches ?? true;
  const lines: string[] = [
    "Use the pr-reviewer skill. Review this pull request without editing files, committing, or pushing.",
    `Write the review JSON described by that skill to ${reportPath} before you exit. This file is mandatory.`,
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

  lines.push(...describePullRequest(ctx));
  if (!includePatches) {
    lines.push(
      "",
      `Run \`git diff origin/${ctx.baseRef}...HEAD\` to see the full change.`,
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

/** Repository, PR title, branches, and description lines shared by agent prompts. */
export function describePullRequest(ctx: ReviewContext): string[] {
  const lines = [
    "",
    `Repository: ${ctx.repo.owner}/${ctx.repo.repo}`,
    `PR #${ctx.prNumber}: ${ctx.title}`,
    `Branch (already checked out): ${ctx.headRef} (base: ${ctx.baseRef})`,
  ];
  if (ctx.body) {
    lines.push(
      "",
      "--- PR description ---",
      ctx.body,
      "--- end PR description ---",
    );
  }
  return lines;
}
