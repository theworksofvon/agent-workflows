import { Check, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, needsAccountChoice } from "../api";
import { SessionAccountPicker } from "./AccountSwitcher";
import { formatTime, plural } from "../lib/format";
import type { ComposedReview, ReviewEvent } from "../types";

const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

export function PublishDialog({
  sessionId,
  prUrl,
  publishedAt,
  onPublished,
  onAccountChosen,
  onClose,
}: {
  sessionId: string;
  prUrl: string | null;
  publishedAt: string | null;
  onPublished: (publishedAt: string) => void;
  /** The reader chose the account of an old session. */
  onAccountChosen?: () => void;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [preview, setPreview] = useState<ComposedReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askAccount, setAskAccount] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    setAskAccount(false);
    setConfirmed(false);
    api.publishPreview(sessionId, event).then(
      (p) => live && setPreview(p),
      (err: Error) => {
        if (!live) return;
        setError(err.message);
        setAskAccount(needsAccountChoice(err));
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, event]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function post() {
    setPosting(true);
    setError(null);
    try {
      const at = await api.publish(sessionId, event);
      setPosted(at);
      onPublished(at);
    } catch (err) {
      setError((err as Error).message);
      setAskAccount(needsAccountChoice(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <header className="modal-head">
          <h2 id="publish-title">Publish review</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {posted ? (
          <div className="modal-body published">
            <div className="published-mark">
              <Check size={22} strokeWidth={2.5} />
            </div>
            <p>
              Posted to GitHub at <strong>{formatTime(posted)}</strong>.
            </p>
            {prUrl && (
              <a className="btn" href={prUrl} target="_blank" rel="noreferrer">
                Open the pull request
                <ExternalLink size={13} />
              </a>
            )}
          </div>
        ) : (
          <div className="modal-body">
            <div className="publish-controls">
              <span className="muted small">Review type</span>
              <div className="segmented" role="group" aria-label="Review type">
                {EVENTS.map((e) => (
                  <button
                    key={e.value}
                    type="button"
                    className={event === e.value ? "is-on" : ""}
                    aria-pressed={event === e.value}
                    onClick={() => setEvent(e.value)}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
            {publishedAt && (
              <div className="banner banner-warn">
                <div className="banner-body">
                  Already published {formatTime(publishedAt)}. A session
                  publishes once; re-run the review to post again.
                </div>
              </div>
            )}
            {error && (
              <div className="banner banner-error">
                <div className="banner-body">
                  {error}
                  {askAccount && (
                    <SessionAccountPicker
                      sessionId={sessionId}
                      onChosen={() => {
                        setError(null);
                        setAskAccount(false);
                        onAccountChosen?.();
                      }}
                    />
                  )}
                </div>
              </div>
            )}
            {!preview && !error && <div className="muted">Building the preview…</div>}
            {preview && <PreviewBody preview={preview} />}
          </div>
        )}

        {!posted && (
          <footer className="modal-foot">
            <label className="check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={!preview || publishedAt !== null}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I reviewed this preview
            </label>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={
                !preview || !confirmed || posting || publishedAt !== null
              }
              onClick={() => void post()}
            >
              {posting ? "Posting…" : "Post to GitHub"}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function PreviewBody({ preview }: { preview: ComposedReview }) {
  return (
    <div className="preview">
      <section>
        <h3>Review body</h3>
        <pre className="preview-pre">{preview.body}</pre>
      </section>
      <section>
        <h3>
          Inline comments <span className="muted">· {preview.comments.length}</span>
        </h3>
        {preview.comments.length === 0 && (
          <p className="muted small">No inline comments.</p>
        )}
        <ul className="preview-comments">
          {preview.comments.map((c, i) => (
            <li key={i} className="preview-comment">
              <div className="mono small preview-loc">
                {c.path}:{c.line}
              </div>
              <pre className="preview-pre">{c.body}</pre>
            </li>
          ))}
        </ul>
      </section>
      {preview.skipped.length > 0 && (
        <section>
          <h3>
            Not posted inline <span className="muted">· {plural(preview.skipped.length, "comment")}</span>
          </h3>
          <ul className="preview-skipped">
            {preview.skipped.map((s, i) => (
              <li key={i}>
                <span className={`who ${s.kind === "human" ? "who-human" : "who-agent"} who-sm`}>
                  {s.kind === "human" ? "You" : "Agent"}
                </span>
                <span className="mono small">
                  {s.path}:{s.line}
                </span>
                <span className="muted small">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
