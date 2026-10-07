import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../api";
import { useData } from "../lib/data";
import { Popover, usePopover } from "./Popover";
import { useToast } from "./Toast";

/** The footer button is narrow; the menu needs room for its warnings. */
const MENU_MIN_W = 248;

/** A GitHub avatar, or the login's first letter when there is none. */
export function Avatar({
  login,
  url,
  size = 18,
}: {
  login: string;
  url: string | null | undefined;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (url && !broken)
    return (
      <img
        className="avatar"
        src={url}
        alt=""
        style={style}
        onError={() => setBroken(true)}
      />
    );
  return (
    <span
      className="avatar avatar-letter"
      style={{ ...style, fontSize: Math.round(size * 0.5) }}
      aria-hidden
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The sidebar's GitHub account menu. Hidden when the server has no accounts. */
export function AccountSwitcher() {
  const { accounts, switchAccount } = useData();
  const pop = usePopover<HTMLButtonElement>();
  const toast = useToast();
  const data = accounts.data;
  if (!data || data.accounts.length === 0) return null;
  const current = data.accounts.find((a) => a.login === data.current);

  async function pick(login: string) {
    pop.close();
    if (login === data!.current) return;
    try {
      await switchAccount(login);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className={`account-btn ${pop.open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={pop.toggle}
        title="Switch GitHub account"
      >
        <Avatar login={data.current} url={current?.avatarUrl} size={18} />
        <span className="account-btn-login">{data.current}</span>
        {current?.ok === false && (
          <span className="badge-warn" title="Run gh auth login.">
            token invalid
          </span>
        )}
        <ChevronsUpDown size={13} className="muted" aria-hidden />
      </button>
      <Popover
        anchor={pop.anchor}
        open={pop.open}
        onClose={pop.close}
        width={Math.max(pop.anchor.current?.offsetWidth ?? 0, MENU_MIN_W)}
        label="GitHub accounts"
      >
        <div className="menu" role="menu" aria-label="GitHub accounts">
          <p className="menu-label">GitHub accounts</p>
          {data.accounts.map((a) => (
            <button
              key={a.login}
              type="button"
              role="menuitemradio"
              aria-checked={a.login === data.current}
              className="menu-item"
              onClick={() => void pick(a.login)}
            >
              <Avatar login={a.login} url={a.avatarUrl} size={18} />
              <span className="menu-item-text">{a.login}</span>
              {a.ok === false && (
                <span
                  className="badge-warn"
                  title="The token of this account was rejected. Run gh auth login."
                >
                  token invalid — run gh auth login
                </span>
              )}
              {a.login === data.current && <Check size={14} aria-hidden />}
            </button>
          ))}
          <p className="menu-foot">
            From <code>gh auth status</code>. Add one with{" "}
            <code>gh auth login</code>.
          </p>
        </div>
      </Popover>
    </>
  );
}

/**
 * Picks the account of an old session that has none. Hidden when the
 * server has no route for it (404). `onChosen` runs after the server
 * accepted the account.
 */
export function SessionAccountPicker({
  sessionId,
  onChosen,
}: {
  sessionId: string;
  onChosen: () => void;
}) {
  const { accounts } = useData();
  const toast = useToast();
  const list = accounts.data?.accounts ?? [];
  const [login, setLogin] = useState(accounts.data?.current ?? "");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  if (missing || list.length === 0) return null;

  async function choose() {
    setBusy(true);
    try {
      await api.setSessionAccount(sessionId, login);
      onChosen();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-picker">
      <select
        className="select"
        value={login}
        aria-label="Account for this review"
        onChange={(e) => setLogin(e.target.value)}
      >
        {list.map((a) => (
          <option key={a.login} value={a.login}>
            {a.login}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || !login}
        onClick={() => void choose()}
      >
        {busy ? "Saving…" : "Use this account"}
      </button>
    </div>
  );
}
