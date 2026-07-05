import type { PullRequestReviewContext } from "./types.js";

export function buildReviewPrompt(ctx: PullRequestReviewContext): string {
  const lines: string[] = [];

  lines.push("You are reviewing a GitHub pull request.");
  lines.push("This is review-only work: do not edit files, commit, push, or leave GitHub comments yourself.");
  lines.push("You are running inside an isolated git worktree for the PR head branch.");
  lines.push("");
  lines.push(`Repository: ${ctx.repo.owner}/${ctx.repo.repo}`);
  lines.push(`PR #${ctx.prNumber}: ${ctx.title}`);
  lines.push(`Branch (you are on it): ${ctx.headRef}  (base: ${ctx.baseRef})`);
  if (ctx.body) {
    lines.push("");
    lines.push("--- PR description ---");
    lines.push(ctx.body);
    lines.push("--- end PR description ---");
  }

  lines.push("");
  lines.push("--- changed files ---");
  for (const file of ctx.files) {
    lines.push(`File: ${file.path}`);
    lines.push(`Status: ${file.status}; +${file.additions}/-${file.deletions}`);
    if (file.patch) {
      lines.push("Patch:");
      lines.push("```diff");
      lines.push(file.patch);
      lines.push("```");
    } else {
      lines.push("Patch: unavailable from GitHub API; inspect the file and git diff locally if needed.");
    }
    lines.push("");
  }
  lines.push("--- end changed files ---");
  lines.push("");
  lines.push("Instructions:");
  lines.push("- Inspect the repository structure, changed files, nearby patterns, package scripts, CI config, and tests before deciding findings.");
  lines.push("- Focus only on actionable defects: bugs, regressions, security or data risks, broken behavior, and missing tests for risky behavior.");
  lines.push("- Do not report style-only, preference, praise, or broad maintainability comments.");
  lines.push("- Only produce inline findings for lines that are part of the PR diff.");
  lines.push("- If your environment supports sub-agents or delegation, use them when it helps split independent files, investigate unfamiliar areas, or parallelize review context gathering.");
  lines.push("- Keep findings concise and specific enough for a PR author to act on immediately.");
  lines.push("- If there are no actionable findings, return an empty findings array.");
  lines.push("");
  lines.push("Output contract:");
  lines.push("- Return JSON only. Do not wrap it in markdown fences and do not include prose outside the JSON.");
  lines.push("- The JSON shape must be:");
  lines.push(`{"summary":"short review summary","findings":[{"path":"relative/file.ts","line":123,"body":"actionable review comment","severity":"critical|high|medium|low"}]}`);

  return lines.join("\n");
}
