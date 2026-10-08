import { MessagesSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { findingAnchor } from "../lib/format";
import { Markdown } from "../lib/markdown";
import type { ApiFinding, FindingVerdict, Verdict } from "../types";

const VERDICTS: { value: Verdict; label: string }[] = [
  { value: "agree", label: "Agree" },
  { value: "disagree", label: "Disagree" },
  { value: "unsure", label: "Unsure" },
];

export const DISAGREE_HINT =
  "Say why — this becomes the case in the posted review";

export function FindingCard({
  finding,
  verdict,
  onChange,
  onAsk,
  showLocation = false,
}: {
  finding: ApiFinding;
  verdict: FindingVerdict | undefined;
  onChange: (verdict: Verdict | null, note: string) => void;
  /** Asks the T3 thread about this finding; absent without T3. */
  onAsk?: () => void;
  showLocation?: boolean;
}) {
  const [note, setNote] = useState(verdict?.note ?? "");
  useEffect(() => setNote(verdict?.note ?? ""), [verdict?.note]);

  const current = verdict?.verdict ?? null;
  const needsReason = current === "disagree" && note.trim() === "";

  return (
    <div
      id={findingAnchor(finding.id)}
      className={`annot finding finding-${finding.severity} ${current ? `verdict-${current}` : ""}`}
    >
      <div className="annot-head">
        <span className="who who-agent">
          <Sparkles size={12} aria-hidden />
          Agent
        </span>
        <span className={`sev sev-${finding.severity}`}>{finding.severity}</span>
        {showLocation && (
          <span className="mono muted small">
            {finding.path}:{finding.line}
          </span>
        )}
        <span className="spacer" />
        {onAsk && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onAsk}
            title="Ask the review's T3 thread about this finding"
          >
            <MessagesSquare size={12} />
            Ask
          </button>
        )}
        <div className="verdicts" role="group" aria-label="Your verdict">
          {VERDICTS.map((v) => (
            <button
              key={v.value}
              type="button"
              className={`verdict-btn verdict-btn-${v.value} ${current === v.value ? "is-on" : ""}`}
              aria-pressed={current === v.value}
              onClick={() =>
                onChange(current === v.value ? null : v.value, note)
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="annot-body prose">
        <Markdown text={finding.body} />
      </div>
      {current && (
        <div className="verdict-note">
          <span className="who who-human who-sm">You</span>
          <textarea
            className="input textarea"
            rows={current === "disagree" ? 2 : 1}
            value={note}
            placeholder={
              current === "disagree"
                ? "Your reason for disagreeing"
                : "Add a note (optional)"
            }
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (verdict?.note ?? "")) onChange(current, note);
            }}
          />
          {needsReason && <p className="hint-warn">{DISAGREE_HINT}</p>}
        </div>
      )}
    </div>
  );
}
