import { Check, Sparkles } from "lucide-react";
import type { MouseEvent } from "react";
import { pad2, plural, SEVERITY_ORDER } from "../lib/format";
import { Inline, Markdown } from "../lib/markdown";
import type { FocusTarget, Jump } from "../lib/review-context";
import { sessionHref } from "../lib/route";
import type {
  ApiFinding,
  Guide,
  HumanState,
  ReviewSession,
} from "../types";
import { FlowDiagram } from "./FlowDiagram";

export function OverviewTab({
  session,
  guide,
  findings,
  human,
  onJump,
}: {
  session: ReviewSession;
  guide: Guide | null;
  findings: ApiFinding[];
  human: HumanState;
  onJump: Jump;
}) {
  const chapterNumbers = new Map(
    guide?.chapters.map((c, i) => [c.id, i + 1]) ?? [],
  );
  const chapterOf = new Map<string, string>();
  for (const c of guide?.chapters ?? []) {
    for (const f of c.files) chapterOf.set(f, c.id);
  }

  return (
    <div className="overview">
      <div className="overview-top">
        <div className="overview-text">
          <h2>Overview</h2>
          {guide ? (
            <>
              <div className="prose">
                <Markdown text={guide.overview.context} />
              </div>
              <ol className="steps-list">
                {guide.overview.steps.map((s, i) => (
                  <li key={i}>
                    <Inline text={s} />
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="prose">
              <p className="muted">
                No guide for this pull request. The description from GitHub:
              </p>
              <Markdown text={session.pr?.body || "No description."} />
            </div>
          )}
        </div>
        <div className="overview-flows">
          {guide?.overview.flows.map((flow, i) => (
            <FlowDiagram
              key={i}
              flow={flow}
              sessionId={session.id}
              chapterNumbers={chapterNumbers}
              onJump={onJump}
            />
          ))}
        </div>
      </div>

      <div className="overview-bottom">
        {guide && (
          <section className="card list-card">
            <div className="list-card-head">
              <h3>Chapters</h3>
              <span className="muted small">
                {guide.chapters.filter((c) => human.chapters[c.id]).length} of{" "}
                {guide.chapters.length} reviewed
              </span>
            </div>
            <ul className="chapter-list">
              {guide.chapters.map((c, i) => (
                <li key={c.id}>
                  <a
                    href={sessionHref(session.id, "guide", c.id)}
                    className="chapter-row"
                    onClick={jumpOnClick(onJump, "Chapters")}
                  >
                    <span className="mono muted">{pad2(i + 1)}</span>
                    <span className="chapter-row-title">{c.title}</span>
                    <span className={`role role-${c.role}`}>{c.role}</span>
                    <span className="muted small">{plural(c.files.length, "file")}</span>
                    <span
                      className={`done-mark ${human.chapters[c.id] ? "is-done" : ""}`}
                      title={human.chapters[c.id] ? "Reviewed" : "Not reviewed"}
                    >
                      <Check size={11} strokeWidth={3} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <FindingsSummary
          session={session}
          findings={findings}
          human={human}
          chapterOf={chapterOf}
          onJump={onJump}
        />
      </div>
    </div>
  );
}

function FindingsSummary({
  session,
  findings,
  human,
  chapterOf,
  onJump,
}: {
  session: ReviewSession;
  findings: ApiFinding[];
  human: HumanState;
  chapterOf: Map<string, string>;
  onJump: Jump;
}) {
  const checked = findings.filter((f) => human.verdicts[f.id]).length;
  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const summary = session.review.value?.summary;

  return (
    <section className="card list-card">
      <div className="list-card-head">
        <h3>
          <span className="who who-agent">
            <Sparkles size={12} />
            Agent
          </span>{" "}
          findings
        </h3>
        <span className="muted small">
          {checked} of {findings.length} checked by you
        </span>
      </div>
      {session.review.adversarial && (
        <p className="muted small list-card-note">
          Includes an adversarial second pass.
        </p>
      )}
      <div className="sev-counts">
        {SEVERITY_ORDER.map((s) => {
          const n = findings.filter((f) => f.severity === s).length;
          return (
            <span key={s} className={`sev-count ${n ? "" : "is-zero"}`}>
              <span className={`sev sev-${s}`}>{s}</span> {n}
            </span>
          );
        })}
      </div>
      {summary && (
        <div className="prose agent-summary">
          <Markdown text={summary} />
        </div>
      )}
      {sorted.length === 0 && !session.review.error && (
        <p className="muted small">The agent found nothing to flag.</p>
      )}
      <ul className="finding-list">
        {sorted.map((f) => {
          const verdict = human.verdicts[f.id]?.verdict;
          const chapter = chapterOf.get(f.path);
          return (
            <li key={f.id}>
              <a
                className="finding-row"
                href={
                  chapter
                    ? sessionHref(session.id, "guide", chapter)
                    : sessionHref(session.id, "diff")
                }
                onClick={jumpOnClick(onJump, "Findings", {
                  findingId: f.id,
                  path: f.path,
                })}
              >
                <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                <span className="finding-row-body">
                  <span className="mono small muted">
                    {f.path}:{f.line}
                  </span>
                  <span className="finding-row-text">
                    <Inline text={f.body.split("\n")[0]!} />
                  </span>
                </span>
                <span className={`verdict-tag verdict-tag-${verdict ?? "none"}`}>
                  {verdict ?? "unchecked"}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A click handler for an overview link that records the jump. A modified
 * click (new tab, new window) keeps the browser default.
 */
export function jumpOnClick(onJump: Jump, label: string, focus?: FocusTarget) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
      return;
    e.preventDefault();
    onJump(label, e.currentTarget.getAttribute("href") ?? "#/", focus);
  };
}
