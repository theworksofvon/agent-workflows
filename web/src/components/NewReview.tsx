import { useState, type FormEvent } from "react";
import { api } from "../api";
import { navigate, sessionHref } from "../lib/route";
import type { OpenPull } from "../types";
import { useToast } from "./Toast";

/** Start a review from a pasted PR, or pick one from a repo's open PRs. */
export function NewReview({
  autoFocus = false,
  onStarted,
}: {
  autoFocus?: boolean;
  onStarted?: () => void;
}) {
  return (
    <div className="new-review">
      <StartReview autoFocus={autoFocus} onStarted={onStarted} />
      <BrowsePulls onStarted={onStarted} />
    </div>
  );
}

function StartReview({
  autoFocus,
  onStarted,
}: {
  autoFocus: boolean;
  onStarted?: () => void;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.createSession(target.trim());
      navigate(sessionHref(id));
      onStarted?.();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="nr-section" onSubmit={submit}>
      <label className="nr-label" htmlFor="nr-target">
        Pull request
      </label>
      <input
        id="nr-target"
        className="input"
        value={target}
        autoFocus={autoFocus}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="owner/repo#123 or a PR URL"
        spellCheck={false}
      />
      {error && <p className="field-error">{error}</p>}
      <button
        className="btn btn-primary btn-block"
        disabled={busy || !target.trim()}
      >
        {busy ? "Starting…" : "Start guided review"}
      </button>
    </form>
  );
}

function BrowsePulls({ onStarted }: { onStarted?: () => void }) {
  const [repo, setRepo] = useState("");
  const [pulls, setPulls] = useState<OpenPull[] | null>(null);
  const [loaded, setLoaded] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function load(e: FormEvent) {
    e.preventDefault();
    const [owner, name] = repo.trim().split("/");
    if (!owner || !name) {
      setError("Use the form owner/repo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPulls(await api.listOpenPulls(owner, name));
      setLoaded(`${owner}/${name}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start(n: number) {
    try {
      navigate(sessionHref(await api.createSession(`${loaded}#${n}`)));
      onStarted?.();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="nr-section">
      <label className="nr-label" htmlFor="nr-repo">
        Browse open PRs
      </label>
      <form className="row" onSubmit={load}>
        <input
          id="nr-repo"
          className="input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo"
          spellCheck={false}
        />
        <button className="btn" disabled={busy}>
          {busy ? "…" : "List"}
        </button>
      </form>
      {error && <p className="field-error">{error}</p>}
      {pulls?.length === 0 && (
        <p className="muted small">No open pull requests.</p>
      )}
      {pulls && pulls.length > 0 && (
        <ul className="pull-list">
          {pulls.map((p) => (
            <li key={p.number}>
              <button
                className="pull-item"
                onClick={() => void start(p.number)}
              >
                <span className="mono muted">#{p.number}</span>
                <span className="pull-title">{p.title}</span>
                {p.draft && <span className="tag">draft</span>}
                <span className="muted small">{p.author}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
