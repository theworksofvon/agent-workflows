import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { ReviewSession, SessionStatus } from "../types";

const STEPS: { status: SessionStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "triaging", label: "Triage" },
  { status: "preparing", label: "Worktree" },
  { status: "analyzing", label: "Guide + review" },
];

/** Stages that name the outcome rather than the step that failed. */
const FINAL_STAGES = ["Failed", "Interrupted"];

export function StatusBanner({
  session,
  onRerun,
}: {
  session: ReviewSession;
  onRerun: () => void;
}) {
  if (session.status === "ready") return null;

  if (session.status === "failed") {
    return (
      <div className="banner banner-error" role="alert">
        <div className="banner-body">
          <strong>This run failed</strong>
          {session.stage && !FINAL_STAGES.includes(session.stage) && (
            <span className="muted"> during {session.stage}</span>
          )}
          <pre className="banner-error-text">
            {session.error ?? "No error message was recorded."}
          </pre>
        </div>
        <button className="btn" onClick={onRerun}>
          Re-run
        </button>
      </div>
    );
  }

  const current = STEPS.findIndex((s) => s.status === session.status);
  return (
    <div className="banner banner-running" role="status">
      <span className="spinner" aria-hidden />
      <div className="banner-body">
        <strong>{session.stage || "Working"}</strong>
        <ol className="steps">
          {STEPS.map((step, i) => (
            <Fragment key={step.status}>
              {i > 0 && (
                <li className="step-sep" aria-hidden>
                  <ChevronRight size={12} />
                </li>
              )}
              <li
                className={
                  i < current ? "step-done" : i === current ? "step-now" : ""
                }
              >
                {step.label}
              </li>
            </Fragment>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** A warning for one part (guide or review) that failed in a ready run. */
export function PartWarning({ title, error }: { title: string; error: string }) {
  return (
    <div className="banner banner-warn" role="alert">
      <div className="banner-body">
        <strong>{title}</strong>
        <pre className="banner-error-text">{error}</pre>
      </div>
    </div>
  );
}
