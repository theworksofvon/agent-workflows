import { useState, type KeyboardEvent } from "react";

export function CommentComposer({
  line,
  onSubmit,
  onCancel,
}: {
  line: number;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!body.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit(body.trim());
    setBusy(false);
    if (ok) onCancel();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") onCancel();
  }

  return (
    <div className="annot human composer">
      <div className="annot-head">
        <span className="who who-human">You</span>
        <span className="muted small">Comment on line {line}</span>
      </div>
      <textarea
        className="input textarea"
        rows={3}
        autoFocus
        value={body}
        placeholder="Write your own review comment. It posts as yours."
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="muted small">⌘↵ to save · Esc to cancel</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!body.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
