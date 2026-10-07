import { useCallback } from "react";
import { api, optional } from "../api";
import type { Remote } from "../lib/data";
import { relativeTime, shortTime } from "../lib/format";
import { inboxNotices } from "../lib/inbox";
import { pullHref, sessionHref } from "../lib/route";
import { statusTone } from "../lib/sessions";
import type { Inbox, InboxGroup, InboxPull, SessionSummary } from "../types";
import { ChecksPopover, PullStateIcon } from "./PullGlyphs";

/** The state of the inbox above its rows: errors, hints, and loading. */
export function InboxNotes({
  inbox,
  group,
  empty,
  query,
  repo,
  onRetry,
}: {
  inbox: Remote<Inbox>;
  group: InboxGroup;
  /** The view shows no rows after the filter. */
  empty: boolean;
  query: string;
  repo: string | null;
  onRetry: () => void;
}) {
  const notices = inboxNotices(inbox.data, group);
  return (
    <>
      {inbox.error && !inbox.data && (
        <p className="sidebar-note error-text">{inbox.error}</p>
      )}
      {inbox.error && inbox.data && (
        <p className="sidebar-note inbox-retry" title={inbox.error}>
          Couldn&apos;t refresh ·{" "}
          <button
            type="button"
            className="link-btn"
            onClick={onRetry}
            disabled={inbox.loading}
          >
            retry
          </button>
          <span className="inbox-retry-time">
            {" "}
            · last fetched {relativeTime(inbox.data.fetchedAt)}
          </span>
        </p>
      )}
      {notices.stale && <p className="sidebar-note">Showing cached results</p>}
      {notices.warnings.map((w) => (
        <p key={w} className="sidebar-note inbox-warning">
          {w}
        </p>
      ))}
      {inbox.loading && !inbox.data && (
        <p className="sidebar-note">Loading pull requests…</p>
      )}
      {inbox.data && empty && (
        <p className="sidebar-note">
          {query
            ? `No pull requests match “${query}”.`
            : `Nothing here${repo ? ` in ${repo}` : ""}.`}
        </p>
      )}
      {notices.truncated && (
        <p className="sidebar-note">
          Showing 50 of more. Narrow the list with the repository filter.
        </p>
      )}
    </>
  );
}

/** One pull request of the inbox, with its checks and guided review. */
export function PullRow({
  pull: p,
  session,
  active,
  onNavigate,
}: {
  pull: InboxPull;
  session: SessionSummary | null;
  active: boolean;
  onNavigate: () => void;
}) {
  // The server's id names the latest run of any status; the list may lag.
  const sessionId = p.sessionId ?? session?.id ?? null;
  const href = sessionId
    ? sessionHref(sessionId)
    : pullHref(p.repo.owner, p.repo.repo, p.number);
  const loadChecks = useCallback(
    () =>
      (sessionId
        ? optional(api.getChecks(sessionId))
        : optional(api.getPullChecks(p.repo.owner, p.repo.repo, p.number))
      ).then((c) => c?.checks ?? null),
    [sessionId, p.repo.owner, p.repo.repo, p.number],
  );
  const tone = session ? statusTone(session.status) : "ready";
  const hasMarks = sessionId !== null || p.checks !== null;

  // The link and the checks button are siblings: a button inside an anchor
  // is invalid, and a click on it must not follow the link.
  return (
    <li className={`pull-row ${active ? "is-active" : ""}`}>
      <a
        className="pull-row-link"
        href={href}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
      >
        <PullStateIcon state={p.state} />
        <span className="pull-row-body">
          <span className="pull-row-title" title={p.title}>
            {p.title}
          </span>
          <span className="pull-row-time">{shortTime(p.updatedAt)}</span>
          <span className="pull-row-meta">
            <span className="pull-row-num">#{p.number}</span>
            <span className="pull-row-author">{p.author.login}</span>
          </span>
          {hasMarks && <span className="pull-row-slot" aria-hidden />}
        </span>
      </a>
      {hasMarks && (
        <span className="pull-row-marks">
          {sessionId && (
            <span
              className={`status-dot status-${tone}`}
              title={`Guided review: ${session?.status ?? "exists"}`}
              role="img"
              aria-label="Has a guided review"
            />
          )}
          <ChecksPopover rollup={p.checks} load={loadChecks} prUrl={p.url} />
        </span>
      )}
    </li>
  );
}
