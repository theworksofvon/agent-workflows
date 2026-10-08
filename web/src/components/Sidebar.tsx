import {
  AtSign,
  Check,
  ChevronDown,
  Compass,
  Eye,
  GitPullRequest,
  Plus,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { useData } from "../lib/data";
import { relativeTime } from "../lib/format";
import { sessionHref } from "../lib/route";
import {
  latestRunOf,
  pullKey,
  sessionSubtitle,
  statusTone,
} from "../lib/sessions";
import { repoGroupId } from "../lib/shell";
import { readStorage, writeStorage, type ThemeSetting } from "../lib/theme";
import {
  availableViews,
  formatCount,
  isInboxView,
  keepRepo,
  parseView,
  viewCounts,
  viewForRepo,
  viewRepos,
  viewRows,
  type SidebarView,
} from "../lib/views";
import type { SessionSummary } from "../types";
import { AccountSwitcher } from "./AccountSwitcher";
import { InboxNotes, PullRow } from "./Inbox";
import { NewReview } from "./NewReview";
import { Popover, usePopover } from "./Popover";
import { ThemeSwitch } from "./ThemeSwitch";

// The key predates the guided reviews view; its old values stay valid.
const VIEW_KEY = "guided-review:inbox-group";
const REPO_KEY = "guided-review:inbox-repo";

const VIEW_ICONS: Record<SidebarView, LucideIcon> = {
  reviewRequested: Eye,
  authored: GitPullRequest,
  involved: AtSign,
  guided: Compass,
};

/** A request to show one repository, from a page's breadcrumb. */
export interface RevealRequest {
  repo: string;
}

export function Sidebar({
  activePull,
  theme,
  onTheme,
  onNavigate,
  searchRef,
  reveal,
  onRevealed,
}: {
  /** `pullKey` of the pull request in the main area. */
  activePull: string | null;
  theme: ThemeSetting;
  onTheme: (theme: ThemeSetting) => void;
  onNavigate: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  reveal: RevealRequest | null;
  onRevealed: () => void;
}) {
  const { sessions, sessionsError, inbox, refreshInbox } = useData();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [savedView, setSavedView] = useState(() => readStorage(VIEW_KEY));
  const [savedRepo, setSavedRepo] = useState(() => readStorage(REPO_KEY));
  const [scrollTo, setScrollTo] = useState<string | null>(null);

  const inboxSupported = !inbox.unsupported;
  const pulls = inbox.data?.pulls ?? null;
  const view = parseView(savedView, inboxSupported);
  const repos = viewRepos(view, pulls, sessions);
  const repo = keepRepo(repos, savedRepo);
  const counts = viewCounts(pulls, sessions);
  const rows = viewRows(view, pulls, sessions, { repo, query });

  function chooseView(v: SidebarView) {
    setSavedView(v);
    writeStorage(VIEW_KEY, v);
  }

  function chooseRepo(r: string | null) {
    setSavedRepo(r);
    writeStorage(REPO_KEY, r ?? "");
  }

  useEffect(() => {
    if (!reveal) return;
    chooseView(viewForRepo(view, pulls, sessions, reveal.repo, inboxSupported));
    if (repo && repo.toLowerCase() !== reveal.repo.toLowerCase())
      chooseRepo(null);
    setScrollTo(reveal.repo);
    onRevealed();
    // Runs once per request, with the data of that moment.
  }, [reveal]);

  useEffect(() => {
    if (!scrollTo) return;
    document
      .getElementById(repoGroupId(scrollTo))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo(null);
  }, [scrollTo]);

  return (
    <aside className="sidebar" aria-label="Pull requests and reviews">
      <div className="sidebar-head">
        <a className="brand" href="#/" onClick={onNavigate}>
          <span className="brand-mark" aria-hidden />
          Guided review
        </a>
        <button
          type="button"
          className={`icon-btn ${creating ? "is-pressed" : ""}`}
          aria-expanded={creating}
          aria-label={creating ? "Close new review" : "New review"}
          title={creating ? "Close" : "New review"}
          onClick={() => setCreating((c) => !c)}
        >
          {creating ? <X size={15} /> : <Plus size={16} />}
        </button>
      </div>
      <div className="sidebar-controls">
        {creating && (
          <div className="sidebar-popover">
            <NewReview
              autoFocus
              onStarted={() => {
                setCreating(false);
                onNavigate();
              }}
            />
          </div>
        )}
        <label className="search">
          <Search size={13} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search pull requests"
            aria-label="Search pull requests and reviews"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            spellCheck={false}
          />
          <kbd className="search-kbd">⌘K</kbd>
        </label>
        <nav className="side-views" aria-label="Views">
          <div className="side-label">
            <span>Views</span>
            {inboxSupported && (
              <button
                type="button"
                className="icon-btn icon-btn-xs"
                onClick={refreshInbox}
                disabled={inbox.loading}
                aria-label="Refresh inbox"
                title={
                  inbox.data
                    ? `Refresh · fetched ${relativeTime(inbox.data.fetchedAt)}`
                    : "Refresh"
                }
              >
                <RefreshCw
                  size={12}
                  className={inbox.loading ? "is-spinning" : undefined}
                />
              </button>
            )}
          </div>
          <ul>
            {availableViews(inboxSupported).map(({ id, label }) => {
              const Icon = VIEW_ICONS[id];
              const on = id === view;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`side-view ${on ? "is-on" : ""}`}
                    aria-current={on ? "true" : undefined}
                    onClick={() => chooseView(id)}
                  >
                    <Icon size={15} aria-hidden />
                    <span className="side-view-label">{label}</span>
                    <span
                      className="side-view-count"
                      aria-label={
                        counts[id] === null ? "loading" : `${counts[id]}`
                      }
                    >
                      {formatCount(counts[id])}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {repos.length > 1 && (
          <RepoFilter repos={repos} value={repo} onChange={chooseRepo} />
        )}
      </div>
      <div className="sidebar-list">
        {isInboxView(view) ? (
          <InboxNotes
            inbox={inbox}
            group={view}
            empty={rows.groups.length === 0}
            query={query}
            repo={repo}
            onRetry={refreshInbox}
          />
        ) : (
          <>
            {sessionsError && (
              <p className="sidebar-note error-text">{sessionsError}</p>
            )}
            {sessions === null && !sessionsError && (
              <p className="sidebar-note">Loading…</p>
            )}
            {sessions?.length === 0 && (
              <p className="sidebar-note">No reviews yet.</p>
            )}
            {sessions && sessions.length > 0 && rows.groups.length === 0 && (
              <p className="sidebar-note">
                {query
                  ? `No reviews match “${query}”.`
                  : `No reviews${repo ? ` in ${repo}` : ""}.`}
              </p>
            )}
          </>
        )}
        {rows.kind === "pulls"
          ? rows.groups.map((g) => (
              <RepoGroup key={g.repo} repo={g.repo} count={g.items.length}>
                {g.items.map((p) => (
                  <PullRow
                    key={p.number}
                    pull={p}
                    session={latestRunOf(sessions, p)}
                    active={activePull === pullKey(p)}
                    onNavigate={onNavigate}
                  />
                ))}
              </RepoGroup>
            ))
          : rows.groups.map((g) => (
              <RepoGroup key={g.repo} repo={g.repo} count={g.items.length}>
                {g.items.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={activePull === pullKey(s)}
                    reviewed={s.reviewedChapters}
                    onNavigate={onNavigate}
                  />
                ))}
              </RepoGroup>
            ))}
      </div>
      <div className="sidebar-foot">
        <AccountSwitcher />
        <ThemeSwitch value={theme} onChange={onTheme} />
      </div>
    </aside>
  );
}

function RepoGroup({
  repo,
  count,
  children,
}: {
  repo: string;
  count: number;
  children: ReactNode;
}) {
  const [owner, name] = repo.split("/");
  return (
    <section className="repo-group" id={repoGroupId(repo)}>
      <h2 className="repo-group-name" title={repo}>
        <span className="repo-group-repo">{name}</span>
        <span className="repo-group-owner">{owner}</span>
        <span className="repo-group-count">{count}</span>
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

/** The repository filter of the list: a chip that opens a menu. */
function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: readonly string[];
  value: string | null;
  onChange: (repo: string | null) => void;
}) {
  const pop = usePopover<HTMLButtonElement>();
  const options: { repo: string | null; label: string }[] = [
    { repo: null, label: "All repos" },
    ...repos.map((r) => ({ repo: r, label: r })),
  ];

  function pick(repo: string | null) {
    pop.close();
    onChange(repo);
  }

  return (
    <div className="repo-filter">
      <button
        ref={pop.anchor}
        type="button"
        className={`repo-chip ${value ? "is-set" : ""} ${pop.open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={pop.toggle}
        title={value ?? "Filter by repository"}
      >
        <span className="repo-chip-label">
          {value ? value.split("/")[1] : "All repos"}
        </span>
        <ChevronDown size={12} aria-hidden />
      </button>
      <Popover
        anchor={pop.anchor}
        open={pop.open}
        onClose={pop.close}
        width={248}
        label="Repositories"
      >
        <div className="menu" role="menu" aria-label="Repositories">
          {options.map((o) => (
            <button
              key={o.repo ?? ""}
              type="button"
              role="menuitemradio"
              aria-checked={o.repo === value}
              className="menu-item"
              onClick={() => pick(o.repo)}
            >
              <span className="menu-item-text">{o.label}</span>
              <span className="menu-item-check">
                {o.repo === value && <Check size={14} aria-hidden />}
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function SessionRow({
  session: s,
  active,
  reviewed,
  onNavigate,
}: {
  session: SessionSummary;
  active: boolean;
  reviewed: number | undefined;
  onNavigate: () => void;
}) {
  const tone = statusTone(s.status);
  const title = s.title ?? `Pull request #${s.prNumber}`;
  return (
    <li>
      <a
        className={`session-row ${active ? "is-active" : ""}`}
        href={sessionHref(s.id)}
        aria-current={active ? "page" : undefined}
        title={`#${s.prNumber} ${title}`}
        onClick={onNavigate}
      >
        <span className="session-row-top">
          <span className={`status-dot status-${tone}`} aria-label={s.status} />
          <span className="session-row-title">
            <span className="session-row-num">#{s.prNumber}</span> {title}
          </span>
          <span className="session-row-time">{relativeTime(s.updatedAt)}</span>
        </span>
        <span
          className={`session-row-sub ${tone === "failed" ? "is-failed" : ""}`}
        >
          {sessionSubtitle(s, reviewed)}
        </span>
      </a>
    </li>
  );
}
