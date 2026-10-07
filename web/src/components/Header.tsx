import { ArrowLeft, Check, ChevronDown, ExternalLink } from "lucide-react";
import { useData, useChecks } from "../lib/data";
import { formatTime, plural, relativeTime } from "../lib/format";
import { sessionHref } from "../lib/route";
import { runsOf, runTime, statusTone } from "../lib/sessions";
import type { ReviewSession, SessionSummary } from "../types";
import { Avatar } from "./AccountSwitcher";
import { Popover, usePopover } from "./Popover";
import { ChecksPopover, ChecksUnavailable, PullStateIcon } from "./PullGlyphs";
import { TriageBadge } from "./TriageBadge";

/**
 * The pull request title and its facts. `compact` is one line, for the
 * guide and the diff: the title with the checks, account, and run chips.
 */
export function Header({
  session,
  checks,
  compact = false,
}: {
  session: ReviewSession;
  checks: ReturnType<typeof useChecks>;
  compact?: boolean;
}) {
  const pr = session.pr;
  const additions = pr?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const deletions = pr?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const pusher = pr?.lastCommit?.authorLogin ?? pr?.lastCommit?.authorName;

  return (
    <header className={`pr-header ${compact ? "pr-header-compact" : ""}`}>
      <div className="pr-title-row">
        <h1 className="pr-title">
          {pr?.state && <PullStateIcon state={pr.state} size={compact ? 15 : 18} />}
          <span>{pr?.title ?? `Pull request #${session.prNumber}`}</span>
        </h1>
        <HeaderChips session={session} checks={checks} />
      </div>
      {pr && !compact && (
        <div className="pr-meta">
          <span className="chip mono">{pr.baseRef}</span>
          <ArrowLeft size={12} className="muted" aria-label="from" />
          <span className="chip mono">{pr.headRef}</span>
          <span className="pr-stat">
            {plural(pr.files.length, "file")}
            <span className="add">+{additions}</span>
            {deletions > 0 && <span className="del">−{deletions}</span>}
          </span>
          <span className="pr-byline muted">
            by{" "}
            {pr.authorAvatarUrl !== undefined && (
              <Avatar login={pr.author} url={pr.authorAvatarUrl} size={16} />
            )}
            <span className="pr-byline-who">{pr.author}</span>
            {pusher && (
              <>
                <span aria-hidden>·</span>
                pushed by <span className="pr-byline-who">{pusher}</span>
                {pr.lastCommit?.committedAt &&
                  ` ${relativeTime(pr.lastCommit.committedAt)}`}
              </>
            )}
          </span>
          <TriageBadge triage={session.triage} />
          <a
            className="ext-link"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
            <ExternalLink size={12} />
          </a>
          {session.publishedAt && (
            <span className="pill pill-published">
              Published {formatTime(session.publishedAt)}
            </span>
          )}
        </div>
      )}
    </header>
  );
}

/** The checks, account, and run chips at the end of the title row. */
function HeaderChips({
  session,
  checks,
}: {
  session: ReviewSession;
  checks: ReturnType<typeof useChecks>;
}) {
  const { sessions, accounts } = useData();
  const pr = session.pr;
  const { runs, index } = runsOf(sessions ?? [], session.id);
  const accountAvatar = accounts.data?.accounts.find(
    (a) => a.login === session.account,
  )?.avatarUrl;

  return (
    <div className="pr-title-end">
      {pr && checks.data?.rollup && (
        <ChecksPopover
          rollup={checks.data.rollup}
          checks={checks.data.checks}
          prUrl={pr.url}
          label
        />
      )}
      {checks.error && !checks.data && <ChecksUnavailable error={checks.error} />}
      {session.account && (
        <span
          className="chip account-chip"
          title="GitHub account for this review"
        >
          <Avatar login={session.account} url={accountAvatar} size={14} />
          {session.account}
        </span>
      )}
      {runs.length > 1 && index >= 0 && (
        <RunSwitcher runs={runs} index={index} />
      )}
    </div>
  );
}

/** `Run 2 of 3 ▾`: every run of this pull request, newest first. */
function RunSwitcher({
  runs,
  index,
}: {
  runs: SessionSummary[];
  index: number;
}) {
  const pop = usePopover<HTMLButtonElement>();
  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className={`btn btn-sm run-switch ${pop.open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={pop.toggle}
      >
        Run {index + 1} of {runs.length}
        <ChevronDown size={13} aria-hidden />
      </button>
      <Popover
        anchor={pop.anchor}
        open={pop.open}
        onClose={pop.close}
        align="end"
        width={260}
        label="Runs"
      >
        <div className="menu" role="menu" aria-label="Runs">
          <p className="menu-label">Runs of this pull request</p>
          {runs
            .map((run, i) => ({ run, i }))
            .reverse()
            .map(({ run, i }) => (
              <a
                key={run.id}
                role="menuitemradio"
                aria-checked={i === index}
                className="menu-item"
                href={sessionHref(run.id)}
                onClick={pop.close}
              >
                <span
                  className={`status-dot status-${statusTone(run.status)}`}
                />
                <span className="menu-item-text">
                  Run {i + 1}
                  {i === runs.length - 1 && (
                    <span className="menu-item-tag">latest</span>
                  )}
                </span>
                <span className="menu-item-meta">
                  {relativeTime(runTime(run))}
                </span>
                <span className="menu-item-check">
                  {i === index && <Check size={14} aria-hidden />}
                </span>
              </a>
            ))}
        </div>
      </Popover>
    </>
  );
}
