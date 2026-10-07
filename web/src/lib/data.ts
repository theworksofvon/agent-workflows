import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, optional } from "../api";
import type { Accounts, Checks, Inbox, SessionSummary } from "../types";
import { checksPollInterval } from "./checks";
import { statusTone } from "./sessions";

const SESSIONS_POLL_MS = 3000;
const INBOX_POLL_MS = 120_000;

/**
 * A feature that loads from the server. `unsupported` means the server
 * answered 404: it is older than the feature, so the page hides it.
 */
export interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  unsupported: boolean;
}

export interface AppData {
  sessions: SessionSummary[] | null;
  sessionsError: string | null;
  refreshSessions(): void;
  accounts: Remote<Accounts>;
  switchAccount(login: string): Promise<void>;
  inbox: Remote<Inbox>;
  refreshInbox(): void;
}

export const DataContext = createContext<AppData>({
  sessions: null,
  sessionsError: null,
  refreshSessions: () => {},
  accounts: idle(),
  switchAccount: async () => {},
  inbox: idle(),
  refreshInbox: () => {},
});

export function useData(): AppData {
  return useContext(DataContext);
}

/** The data the sidebar and the pages share, loaded once for the app. */
export function useAppData(activeId: string | null): AppData {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Remote<Accounts>>(loading);
  const [inbox, setInbox] = useState<Remote<Inbox>>(loading);
  const inboxSeq = useRef(0);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
      setSessionsError(null);
    } catch (err) {
      setSessionsError((err as Error).message);
    }
  }, []);

  // Load again when the open session changes: a new run adds a row.
  useEffect(() => {
    void loadSessions();
  }, [loadSessions, activeId]);

  const running =
    sessions?.some((s) => statusTone(s.status) === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => void loadSessions(),
      SESSIONS_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [running, loadSessions]);

  const loadInbox = useCallback(async (refresh: boolean) => {
    const seq = ++inboxSeq.current;
    setInbox((s) => ({ ...s, loading: true }));
    try {
      const data = await optional(api.getInbox(refresh));
      if (seq !== inboxSeq.current) return;
      setInbox(
        data
          ? { data, error: null, loading: false, unsupported: false }
          : { ...idle(), unsupported: true },
      );
    } catch (err) {
      if (seq !== inboxSeq.current) return;
      setInbox((s) => ({
        ...s,
        error: (err as Error).message,
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await optional(api.getAccounts());
        setAccounts(
          data
            ? { data, error: null, loading: false, unsupported: false }
            : { ...idle(), unsupported: true },
        );
      } catch (err) {
        setAccounts({ ...idle(), error: (err as Error).message });
      }
    })();
    void loadInbox(false);
  }, [loadInbox]);

  const inboxSupported = !inbox.unsupported;
  useEffect(() => {
    if (!inboxSupported) return;
    const timer = window.setInterval(
      () => void loadInbox(false),
      INBOX_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [inboxSupported, loadInbox]);

  const switchAccount = useCallback(
    async (login: string) => {
      const current = await api.setCurrentAccount(login);
      setAccounts((s) => (s.data ? { ...s, data: { ...s.data, current } } : s));
      setInbox((s) => ({ ...s, data: null }));
      await loadInbox(false);
    },
    [loadInbox],
  );

  return {
    sessions,
    sessionsError,
    refreshSessions: () => void loadSessions(),
    accounts,
    switchAccount,
    inbox,
    refreshInbox: () => void loadInbox(true),
  };
}

/**
 * The CI checks of a session's pull request. Polls every 60 s while the
 * page is visible and every 30 s while the rollup is pending. A hidden page
 * does not poll and reads once when it shows again. Null data with
 * `unsupported` means an older server.
 */
export function useChecks(sessionId: string): Remote<Checks> {
  const [state, setState] = useState<Remote<Checks>>(loading);
  const [hidden, setHidden] = useState(() => document.hidden);

  const load = useCallback(async () => {
    try {
      const data = await optional(api.getChecks(sessionId));
      setState(
        data
          ? { data, error: null, loading: false, unsupported: false }
          : { ...idle(), unsupported: true },
      );
    } catch (err) {
      setState((s) => ({
        ...s,
        error: (err as Error).message,
        loading: false,
      }));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const unsupported = state.unsupported;
  const interval = unsupported
    ? null
    : checksPollInterval(state.data?.rollup, hidden);
  const wasHidden = useRef(hidden);
  useEffect(() => {
    // The page came back: read now instead of waiting for the next tick.
    if (wasHidden.current && !hidden) void load();
    wasHidden.current = hidden;
  }, [hidden, load]);
  useEffect(() => {
    if (interval === null) return;
    const timer = window.setInterval(() => void load(), interval);
    return () => window.clearInterval(timer);
  }, [interval, load]);

  return state;
}

function idle<T>(): Remote<T> {
  return { data: null, error: null, loading: false, unsupported: false };
}

function loading<T>(): Remote<T> {
  return { data: null, error: null, loading: true, unsupported: false };
}
