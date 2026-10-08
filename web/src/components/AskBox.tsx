import { MessagesSquare, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { AskTarget } from "../lib/review-context";

/** A small box at the bottom right that sends a question to the T3 thread. */
export function AskBox({
  target,
  onSend,
  onClose,
}: {
  target: AskTarget;
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSend(text.trim());
    setBusy(false);
    if (ok) onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") onClose();
  }

  return (
    <div className="ask-box" role="dialog" aria-label="Ask in T3">
      <div className="ask-head">
        <MessagesSquare size={14} />
        <span>
          Ask in T3 about <span className="mono">{describe(target)}</span>
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <textarea
        className="input textarea"
        rows={3}
        autoFocus
        value={text}
        placeholder="Why is this risky?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="muted small">⌘↵ to send · Esc to close</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!text.trim() || busy}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function describe(target: AskTarget): string {
  if (!target.path) return "this finding";
  const { lines } = target;
  if (!lines) return target.path;
  return lines.start === lines.end
    ? `${target.path}:${lines.start}`
    : `${target.path}:${lines.start}–${lines.end}`;
}
