import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  CHECK_STATUS_LABELS,
  checkWorkflowLabel,
  dedupeChecks,
  ROLLUP_LABELS,
  sortChecks,
  summarizeChecks,
} from "../lib/checks";
import type { Check, CheckStatus, ChecksRollup, PullState } from "../types";
import { Popover, usePopover } from "./Popover";

const STATE: Record<PullState, { label: string; Icon: LucideIcon }> = {
  open: { label: "Open", Icon: GitPullRequest },
  draft: { label: "Draft", Icon: GitPullRequestDraft },
  merged: { label: "Merged", Icon: GitMerge },
  closed: { label: "Closed", Icon: GitPullRequestClosed },
};

const ROLLUP: Record<Exclude<ChecksRollup, null>, LucideIcon> = {
  passing: CircleCheck,
  failing: CircleX,
  pending: CircleDot,
};

const CHECK_ICON: Record<CheckStatus, LucideIcon> = {
  pending: Loader,
  success: CircleCheck,
  failure: CircleX,
  cancelled: CircleX,
  skipped: CircleDashed,
  neutral: CircleDashed,
};

export function pullStateLabel(state: PullState): string {
  return STATE[state].label;
}

export function PullStateIcon({
  state,
  size = 16,
}: {
  state: PullState;
  size?: number;
}) {
  const { label, Icon } = STATE[state] ?? STATE.open;
  return (
    <span className={`pr-state pr-state-${state}`} title={label}>
      <Icon size={size} role="img" aria-label={label} />
    </span>
  );
}

/** GitHub's state badge: icon and word on a filled pill. */
export function PullStateBadge({ state }: { state: PullState }) {
  const { label, Icon } = STATE[state] ?? STATE.open;
  return (
    <span className={`pr-badge pr-badge-${state}`}>
      <Icon size={14} aria-hidden />
      {label}
    </span>
  );
}

export function CheckStatusIcon({ status }: { status: CheckStatus }) {
  const Icon = CHECK_ICON[status];
  return (
    <Icon
      size={14}
      aria-hidden
      className={`check-icon check-${status} ${status === "pending" ? "is-spinning" : ""}`}
    />
  );
}

export function RollupIcon({
  rollup,
  size = 14,
}: {
  rollup: Exclude<ChecksRollup, null>;
  size?: number;
}) {
  const Icon = ROLLUP[rollup];
  return <Icon size={size} aria-hidden className={`rollup rollup-${rollup}`} />;
}

/**
 * The checks rollup icon and the popover it opens. With `checks` the popover
 * lists them; with `load` it reads them when it opens; with neither it links
 * to the pull request's checks on GitHub.
 */
export function ChecksPopover({
  rollup,
  checks,
  load,
  prUrl,
  size = 14,
  label = false,
}: {
  rollup: ChecksRollup;
  checks?: readonly Check[];
  load?: () => Promise<readonly Check[] | null>;
  prUrl: string;
  size?: number;
  /** Show the rollup headline beside the icon. */
  label?: boolean;
}) {
  const pop = usePopover<HTMLButtonElement>();
  if (!rollup) return null;
  const headline = ROLLUP_LABELS[rollup];

  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Checks: ${headline}`}
        aria-expanded={pop.open}
        title={headline}
        className={`checks-trigger ${label ? "has-label" : ""} ${pop.open ? "is-open" : ""}`}
        onClick={pop.toggle}
      >
        <RollupIcon rollup={rollup} size={size} />
        {label && (
          <span className="checks-trigger-label">{shortRollup(rollup)}</span>
        )}
      </button>
      <Popover
        anchor={pop.anchor}
        open={pop.open}
        onClose={pop.close}
        width={340}
        label="Checks"
      >
        <div className="checks-pop">
          <p className="checks-pop-title">
            <RollupIcon rollup={rollup} />
            {headline}
          </p>
          {checks ? (
            <ChecksList checks={checks} prUrl={prUrl} />
          ) : load ? (
            <LazyChecks load={load} prUrl={prUrl} />
          ) : (
            <ChecksLink prUrl={prUrl} />
          )}
        </div>
      </Popover>
    </>
  );
}

/** A neutral chip for a checks read that failed. The error is the tooltip. */
export function ChecksUnavailable({ error }: { error: string }) {
  return (
    <span
      className="checks-trigger has-label checks-unavailable"
      title={error}
      role="status"
    >
      <CircleDashed size={14} aria-hidden className="rollup" />
      <span className="checks-trigger-label">Checks unavailable</span>
    </span>
  );
}

function shortRollup(rollup: Exclude<ChecksRollup, null>): string {
  return rollup === "passing"
    ? "Checks passed"
    : rollup === "failing"
      ? "Checks failed"
      : "Checks running";
}

function LazyChecks({
  load,
  prUrl,
}: {
  load: () => Promise<readonly Check[] | null>;
  prUrl: string;
}) {
  const [checks, setChecks] = useState<readonly Check[] | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (c) => live && setChecks(c),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (error) return <p className="checks-pop-note error-text">{error}</p>;
  if (checks === undefined)
    return <p className="checks-pop-note">Loading checks…</p>;
  if (checks === null) return <ChecksLink prUrl={prUrl} />;
  return <ChecksList checks={checks} prUrl={prUrl} />;
}

export function ChecksList({
  checks,
  prUrl,
}: {
  checks: readonly Check[];
  prUrl: string;
}) {
  const rows = sortChecks(dedupeChecks(checks));
  return (
    <>
      <p className="checks-pop-note">{summarizeChecks(rows)}</p>
      {rows.length > 0 && (
        <ul className="checks-list">
          {rows.map((c, i) => {
            const workflow = checkWorkflowLabel(c);
            return (
              <li key={`${i}:${c.name}`} className="checks-row">
                <CheckStatusIcon status={c.status} />
                <span
                  className="checks-row-name"
                  title={workflow ? `${workflow} / ${c.name}` : c.name}
                >
                  {c.name}
                  {workflow && (
                    <span className="checks-row-workflow">{workflow}</span>
                  )}
                </span>
                <span className="checks-row-status">
                  {CHECK_STATUS_LABELS[c.status]}
                </span>
                {c.url ? (
                  <a
                    className="checks-row-link"
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Details
                  </a>
                ) : (
                  <span className="checks-row-link" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ChecksLink prUrl={prUrl} />
    </>
  );
}

function ChecksLink({ prUrl }: { prUrl: string }) {
  return (
    <a
      className="checks-pop-foot"
      href={`${prUrl}/checks`}
      target="_blank"
      rel="noreferrer"
    >
      View checks on GitHub
      <ExternalLink size={11} />
    </a>
  );
}
