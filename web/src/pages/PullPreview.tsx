import { ArrowLeft, ExternalLink, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api, optional } from "../api";
import { Avatar } from "../components/AccountSwitcher";
import {
  ChecksList,
  ChecksPopover,
  PullStateBadge,
} from "../components/PullGlyphs";
import { useToast } from "../components/Toast";
import { TopBarShell } from "../components/TopBar";
import { ROLLUP_LABELS } from "../lib/checks";
import { useData } from "../lib/data";
import { bodyExcerpt, plural, relativeTime } from "../lib/format";
import { findPull, INBOX_GROUPS } from "../lib/inbox";
import { navigate, sessionHref } from "../lib/route";
import { useShell } from "../lib/shell";
import { latestRunOf } from "../lib/sessions";
import type { Checks, InboxPull, PullDetail } from "../types";

const DECISION_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
} as const;

/** A pull request from the inbox that has no guided review yet. */
export function PullPreview({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { inbox, sessions, accounts } = useData();
  const shell = useShell();
  const fromInbox = findPull(inbox.data?.pulls, owner, repo, number);
  // `undefined` is loading, `null` is a server without the route.
  const [detail, setDetail] = useState<PullDetail | null | undefined>();
  const [fetched, setFetched] = useState<InboxPull | null | undefined>();
  const [checks, setChecks] = useState<Checks | null | undefined>();
  const [checksError, setChecksError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const toast = useToast();

  // The pull itself, so a pull outside the inbox (a shared link, or past the
  // first 50) resolves, and the description is there.
  useEffect(() => {
    let live = true;
    optional(api.getPull(owner, repo, number))
      .then((p) => live && setDetail(p))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [owner, repo, number]);

  useEffect(() => {
    let live = true;
    optional(api.getPullChecks(owner, repo, number))
      .then((c) => live && setChecks(c))
      .catch((err: Error) => {
        if (!live) return;
        setChecks(null);
        setChecksError(err.message);
      });
    return () => {
      live = false;
    };
  }, [owner, repo, number]);

  // An older server has no pull route: the repo's list stands in.
  const needsList = detail === null && !fromInbox && !inbox.loading;
  useEffect(() => {
    if (!needsList) return;
    let live = true;
    optional(api.listRepoPulls(owner, repo))
      .then((pulls) => {
        if (live) setFetched(findPull(pulls, owner, repo, number));
      })
      .catch(() => live && setFetched(null));
    return () => {
      live = false;
    };
  }, [needsList, owner, repo, number]);

  const pull: PullDetail | InboxPull | null =
    detail ?? fromInbox ?? fetched ?? null;
  const body = detail ? bodyExcerpt(detail.body) : "";
  const existing = pull ? latestRunOf(sessions, pull) : null;
  const account = accounts.data?.current;

  async function start() {
    setStarting(true);
    try {
      const id = await api.createSession(`${owner}/${repo}#${number}`, account);
      navigate(sessionHref(id));
    } catch (err) {
      toast((err as Error).message, "error");
      setStarting(false);
    }
  }

  const crumbs = (
    <>
      <button
        type="button"
        className="crumb"
        title={`${owner}/${repo}`}
        onClick={() => shell.revealRepo(`${owner}/${repo}`)}
      >
        {repo}
      </button>
      <span className="crumb-sep" aria-hidden>
        /
      </span>
      <span className="crumb crumb-pr crumb-current">#{number}</span>
    </>
  );

  if (!pull) {
    return (
      <>
        <TopBarShell>{crumbs}</TopBarShell>
        <main className="page">
          <p className="muted">
            {detail === null && fetched === null
              ? `${owner}/${repo}#${number} is not in the inbox or the repository's open pull requests.`
              : "Loading pull request…"}
          </p>
        </main>
      </>
    );
  }

  const groups = INBOX_GROUPS.filter((g) => pull.groups.includes(g.id));
  const pusher = pull.lastCommit?.authorLogin ?? pull.lastCommit?.authorName;

  return (
    <>
      <TopBarShell
        end={
          <a
            className="btn btn-ghost"
            href={pull.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            <span className="btn-label">Open on GitHub</span>
          </a>
        }
      >
        {crumbs}
      </TopBarShell>
      <main className="page preview">
        <header className="pr-header">
          <h1 className="pr-title">
            {pull.title} <span className="pr-title-num">#{pull.number}</span>
          </h1>
          <div className="pr-meta">
            <PullStateBadge state={pull.state} />
            <span className="pr-byline">
              <Avatar login={pull.author.login} url={pull.author.avatarUrl} />
              <strong>{pull.author.login}</strong>
              <span className="muted">wants to merge into</span>
              <span className="chip mono">{pull.baseRef}</span>
              <ArrowLeft size={12} className="muted" aria-label="from" />
              <span className="chip mono">{pull.headRef}</span>
            </span>
          </div>
        </header>

        <section className="preview-grid">
          <div className="card preview-card">
            <dl className="facts">
              <dt>Changes</dt>
              <dd>
                {pull.changedFiles === null ? (
                  <span className="muted">Unknown</span>
                ) : (
                  <span className="pr-stat">
                    {plural(pull.changedFiles, "file")}
                    {pull.additions !== null && (
                      <span className="add">+{pull.additions}</span>
                    )}
                    {pull.deletions !== null && (
                      <span className="del">−{pull.deletions}</span>
                    )}
                  </span>
                )}
              </dd>
              <dt>Last push</dt>
              <dd>
                {pusher ? (
                  <>
                    {pusher}
                    {pull.lastCommit?.committedAt && (
                      <span className="muted">
                        {" "}
                        · {relativeTime(pull.lastCommit.committedAt)}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">Unknown</span>
                )}
              </dd>
              <dt>Checks</dt>
              <dd>
                {(checks?.rollup ?? pull.checks) ? (
                  <span className="facts-checks">
                    <ChecksPopover
                      rollup={checks?.rollup ?? pull.checks}
                      checks={checks?.checks}
                      prUrl={pull.url}
                    />
                    {ROLLUP_LABELS[(checks?.rollup ?? pull.checks)!]}
                  </span>
                ) : (
                  <span className="muted">No checks reported</span>
                )}
              </dd>
              <dt>Review</dt>
              <dd>
                {pull.reviewDecision ? (
                  DECISION_LABELS[pull.reviewDecision]
                ) : (
                  <span className="muted">No decision</span>
                )}
              </dd>
              <dt>Inbox</dt>
              <dd className="facts-tags">
                {groups.length ? (
                  groups.map((g) => (
                    <span key={g.id} className="tag">
                      {g.title}
                    </span>
                  ))
                ) : (
                  <span className="muted">Not in your inbox</span>
                )}
              </dd>
              <dt>Updated</dt>
              <dd>{relativeTime(pull.updatedAt)}</dd>
            </dl>
            {body && (
              <section className="preview-section" aria-label="Description">
                <h2>Description</h2>
                <p className="preview-body">{body}</p>
              </section>
            )}
            {checks && checks.checks.length > 0 && (
              <section className="preview-section" aria-label="Checks">
                <h2>Checks</h2>
                <ChecksList checks={checks.checks} prUrl={pull.url} />
              </section>
            )}
            {checksError && (
              <p className="preview-section muted small">
                Checks unavailable: {checksError}
              </p>
            )}
          </div>

          <div className="card preview-start">
            <h2>Guided review</h2>
            {existing ? (
              <>
                <p className="muted">
                  This pull request has a guided review from{" "}
                  {relativeTime(existing.updatedAt)}.
                </p>
                <a
                  className="btn btn-primary btn-block"
                  href={sessionHref(existing.id)}
                >
                  Open the review
                </a>
              </>
            ) : (
              <>
                <p className="muted">
                  The agents triage the change, split it into chapters, and flag
                  findings. Nothing goes to GitHub until you publish.
                </p>
                <button
                  className="btn btn-primary btn-block"
                  onClick={() => void start()}
                  disabled={
                    starting ||
                    pull.state === "merged" ||
                    pull.state === "closed"
                  }
                >
                  <Play size={14} />
                  {starting ? "Starting…" : "Start guided review"}
                </button>
                {account && (
                  <p className="preview-as">
                    <Avatar
                      login={account}
                      url={
                        accounts.data?.accounts.find((a) => a.login === account)
                          ?.avatarUrl
                      }
                      size={14}
                    />
                    Runs as <strong>{account}</strong>
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
