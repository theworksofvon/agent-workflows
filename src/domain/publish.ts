import { MARKER_TAG, findingId, type ReviewResult } from "./decisions.js";
import type { PullRequestFile } from "./pull-request.js";
import type { Guide } from "./guide.js";
import { postableLinePredicate } from "./patch-lines.js";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/*
 * Structural views of the session and human state. They match
 * ReviewSession and HumanState in adapters/state/review-sessions.ts, which
 * the domain layer does not import.
 */
export interface PublishSession {
  guide: { value: Guide | null };
  review: { value: ReviewResult | null };
}

export interface PublishHumanState {
  chapters: Record<string, boolean>;
  files: Record<string, boolean>;
  verdicts: Record<
    string,
    { verdict: "agree" | "disagree" | "unsure"; note: string }
  >;
  comments: { path: string; line: number; body: string }[];
}

export interface ComposedComment {
  path: string;
  line: number;
  body: string;
}

export interface SkippedComment {
  kind: "human" | "agent";
  path: string;
  line: number;
  reason: string;
}

export interface ComposedReview {
  event: ReviewEvent;
  body: string;
  comments: ComposedComment[];
  skipped: SkippedComment[];
}

export function composeReview(args: {
  session: PublishSession;
  human: PublishHumanState;
  event: ReviewEvent;
  files: PullRequestFile[];
}): ComposedReview {
  const { session, human, files } = args;
  const onDiff = postableLinePredicate(files);
  const findings = session.review.value?.findings ?? [];

  const comments: ComposedComment[] = [];
  const skipped: SkippedComment[] = [];
  const outside: string[] = [];
  const rejected: string[] = [];
  const counts = { agree: 0, disagree: 0, unsure: 0, unchecked: 0 };

  const place = (
    kind: SkippedComment["kind"],
    comment: ComposedComment,
    label: string,
  ): void => {
    if (onDiff(comment)) {
      comments.push(comment);
      return;
    }
    skipped.push({
      kind,
      path: comment.path,
      line: comment.line,
      reason: "line is not part of the PR diff",
    });
    outside.push(
      `- \`${comment.path}:${comment.line}\` (${label}) ${firstLine(comment.body)}`,
    );
  };

  for (const comment of human.comments) {
    place(
      "human",
      { path: comment.path, line: comment.line, body: comment.body },
      "human comment",
    );
  }

  for (const finding of findings) {
    const entry = human.verdicts[findingId(finding)];
    if (entry?.verdict === "disagree") {
      counts.disagree += 1;
      rejected.push(
        `- \`${finding.path}:${finding.line}\` (${finding.severity}) ${firstLine(finding.body)} — **Reviewer:** ${entry.note || "no reason given"}`,
      );
      continue;
    }
    let status = "not yet checked by a human";
    if (entry?.verdict === "agree") status = "reviewer agrees";
    if (entry?.verdict === "unsure") status = "reviewer unsure";
    counts[entry?.verdict ?? "unchecked"] += 1;
    const note = entry?.note ? `\n\n> Reviewer: ${entry.note}` : "";
    place(
      "agent",
      {
        path: finding.path,
        line: finding.line,
        body: `${MARKER_TAG}\n**Agent finding · ${finding.severity} · ${status}**\n\n${finding.body}${note}`,
      },
      "agent finding",
    );
  }

  const chapters = session.guide.value?.chapters ?? [];
  const chaptersDone = chapters.filter((c) => human.chapters[c.id]).length;
  const filesDone = files.filter((f) => human.files[f.path]).length;
  const n = human.comments.length;

  const sections = [
    MARKER_TAG,
    "## Guided review",
    `${chaptersDone} of ${chapters.length} chapters and ${filesDone} of ${files.length} files reviewed by a human.`,
    `${n} human ${n === 1 ? "comment" : "comments"}. Agent findings: agree ${counts.agree} · disagree ${counts.disagree} · unsure ${counts.unsure} · unchecked ${counts.unchecked}`,
  ];
  const summary = session.review.value?.summary;
  if (summary) sections.push("### Agent summary", summary);
  if (rejected.length) {
    sections.push(
      "### Agent findings the reviewer rejected",
      rejected.join("\n"),
    );
  }
  if (outside.length) {
    sections.push("### Comments outside the diff", outside.join("\n"));
  }

  return { event: args.event, body: sections.join("\n\n"), comments, skipped };
}

function firstLine(text: string): string {
  return text.replace(/\n[\s\S]*/, "");
}
