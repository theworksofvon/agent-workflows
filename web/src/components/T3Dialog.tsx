import { Copy, Link2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "./Toast";
import { formatTime } from "../lib/format";
import type { T3Status } from "../types";

/**
 * Says how a T3 sign-in ended. T3 returns the browser with `?t3=connected`
 * or `?t3=failed&reason=…`; the notice shows once and clears the query.
 */
export function T3SignInNotice() {
  const toast = useToast();
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const result = query.get("t3");
    if (!result) return;
    if (result === "connected")
      toast("T3 is connected. Open in T3 now opens the review's thread.");
    else toast(`T3 sign-in failed: ${query.get("reason") ?? "unknown"}`, "error");
    window.history.replaceState(null, "", `/${window.location.hash}`);
  }, [toast]);
  return null;
}

/**
 * Connects the app to T3 Code, so "Open in T3" can open each review in its
 * own thread. Without T3, the reviewer can still copy a prompt.
 */
export function T3Dialog({
  status,
  onChanged,
  onCopyPrompt,
  onClose,
}: {
  status: T3Status;
  onChanged: (status: T3Status) => void;
  onCopyPrompt: () => void;
  onClose: () => void;
}) {
  const [mcpUrl, setMcpUrl] = useState(status.mcpUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      // T3's sign-in page returns the browser to this app when it finishes.
      window.location.href = await api.t3Connect(
        mcpUrl.trim(),
        window.location.hash,
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function disconnect() {
    onChanged(await api.t3Disconnect());
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="t3-title"
      >
        <header className="modal-head">
          <h2 id="t3-title">Connect T3 Code</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">
          {status.connected ? (
            <p>
              Connected to <span className="mono">{status.mcpUrl}</span>
              {status.expiresAt && <> until {formatTime(status.expiresAt)}</>}.
            </p>
          ) : (
            <>
              <p>
                Each review opens in its own T3 thread, with the review beside
                the chat. In T3, open <strong>Settings → Connections</strong>,
                choose <strong>Copy MCP URL</strong>, and paste it here.
              </p>
              <input
                className="input mono"
                value={mcpUrl}
                placeholder="http://localhost:3773/mcp"
                onChange={(e) => setMcpUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void connect()}
                autoFocus
              />
              <p className="muted small">
                T3 asks you to approve the sign-in. Choose{" "}
                <strong>Supervised</strong> or a broader mode: read-only access
                cannot open threads. The app keeps the token for 30 days and
                never shows it.
              </p>
            </>
          )}
          {error && <div className="banner banner-error">{error}</div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCopyPrompt}>
            <Copy size={14} />
            Copy prompt instead
          </button>
          <span className="spacer" />
          {status.connected ? (
            <button
              type="button"
              className="btn"
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || mcpUrl.trim() === ""}
              onClick={() => void connect()}
            >
              <Link2 size={14} />
              {busy ? "Opening T3…" : "Connect"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
