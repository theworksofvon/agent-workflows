import { MessagesSquare, PanelLeft, RotateCw, Send } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { runFinished } from "../lib/format";
import { TAB_LABELS, type Crumb } from "../lib/orientation";
import { sessionHref, TABS, type SessionTab } from "../lib/route";
import { useShell } from "../lib/shell";
import type { ReviewSession } from "../types";

export interface Progress {
  chapters: { done: number; total: number };
  files: { done: number; total: number };
}

/** The 52px bar over the main area, with the sidebar toggle at its start. */
export function TopBarShell({
  children,
  end,
  below,
}: {
  children: ReactNode;
  end?: ReactNode;
  /** A row under the bar that stays with it, such as the back pill. */
  below?: ReactNode;
}) {
  const shell = useShell();
  return (
    <div className="head">
      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={shell.toggleSidebar}
          aria-label={shell.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-expanded={shell.sidebarOpen}
          title={shell.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          <PanelLeft size={16} />
        </button>
        <nav className="crumbs" aria-label="Breadcrumb">
          {children}
        </nav>
        {end && <div className="topbar-end">{end}</div>}
      </header>
      {below}
    </div>
  );
}

export function SessionTopBar({
  session,
  crumbs,
  onCrumb,
  tab,
  chapterId,
  progress,
  onDiscuss,
  onPublish,
  onRerun,
  below,
}: {
  session: ReviewSession;
  crumbs: Crumb[];
  onCrumb: (crumb: Crumb) => void;
  tab: SessionTab;
  chapterId: string | null;
  progress: Progress;
  onDiscuss: () => void;
  onPublish: () => void;
  onRerun: () => void;
  below?: ReactNode;
}) {
  const ready = session.status === "ready";
  const finished = runFinished(session.status);

  return (
    <TopBarShell
      below={below}
      end={
        <>
          {ready && (
            <div className="segmented" role="tablist" aria-label="View">
              {TABS.map((t, i) => (
                <a
                  key={t}
                  role="tab"
                  aria-selected={t === tab}
                  className={t === tab ? "is-on" : ""}
                  href={sessionHref(
                    session.id,
                    t,
                    t === "guide" ? chapterId : null,
                  )}
                  title={`${TAB_LABELS[t]} (${i + 1})`}
                >
                  {TAB_LABELS[t]}
                </a>
              ))}
            </div>
          )}
          {ready && (
            <span className="topbar-progress" title="Reviewed so far">
              {progress.chapters.total > 0 && (
                <>
                  <strong>{progress.chapters.done}</strong>/
                  {progress.chapters.total} chapters ·{" "}
                </>
              )}
              <strong>{progress.files.done}</strong>/{progress.files.total}{" "}
              files
            </span>
          )}
          <span className="topbar-sep" aria-hidden />
          <button
            className="btn btn-ghost btn-t3"
            onClick={onDiscuss}
            disabled={!ready}
            title="Copy a prompt that opens this review in a T3 thread"
          >
            <MessagesSquare size={14} />
            <span className="btn-label">Open in T3</span>
          </button>
          <button
            className="btn btn-ghost"
            onClick={onRerun}
            disabled={!finished}
            title={finished ? "Start a new run" : "Wait for this run to finish"}
          >
            <RotateCw size={14} />
            <span className="btn-label">Re-run</span>
          </button>
          <button
            className="btn btn-primary"
            onClick={onPublish}
            disabled={!ready}
          >
            <Send size={14} />
            Publish
          </button>
        </>
      }
    >
      {crumbs.map((c, i) => (
        <Fragment key={c.kind}>
          {i > 0 && (
            <span className="crumb-sep" aria-hidden>
              /
            </span>
          )}
          <button
            type="button"
            className={`crumb crumb-${c.kind} ${i === crumbs.length - 1 ? "crumb-current" : ""}`}
            title={c.title ?? c.label}
            aria-current={i === crumbs.length - 1 ? "location" : undefined}
            onClick={() => onCrumb(c)}
          >
            {c.label}
          </button>
        </Fragment>
      ))}
    </TopBarShell>
  );
}
