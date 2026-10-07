import type { InboxGroup, InboxPull, SessionSummary } from "../types";
import { filterInbox, INBOX_GROUPS } from "./inbox";
import { latestRunPerPull, matchesQuery, repoName } from "./sessions";

/** A list that the sidebar shows: one inbox group, or the guided reviews. */
export type SidebarView = InboxGroup | "guided";

export const SIDEBAR_VIEWS: readonly { id: SidebarView; label: string }[] = [
  { id: "reviewRequested", label: "Review requested" },
  { id: "authored", label: "Created by me" },
  { id: "involved", label: "Involved" },
  { id: "guided", label: "Guided reviews" },
];

export type ViewCounts = Record<SidebarView, number | null>;

export interface ViewGroup<T> {
  /** `owner/repo` */
  repo: string;
  items: T[];
}

export type ViewRows =
  | { kind: "pulls"; groups: ViewGroup<InboxPull>[] }
  | { kind: "sessions"; groups: ViewGroup<SessionSummary>[] };

export interface ViewFilter {
  /** `owner/repo`, or null for every repository. */
  repo: string | null;
  query: string;
}

export function isInboxView(view: SidebarView): view is InboxGroup {
  return view !== "guided";
}

/** The views that the server can fill. Without an inbox, only "guided". */
export function availableViews(
  inboxSupported: boolean,
): readonly { id: SidebarView; label: string }[] {
  return inboxSupported
    ? SIDEBAR_VIEWS
    : SIDEBAR_VIEWS.filter((v) => !isInboxView(v.id));
}

/** The saved view if the server can fill it, else the first view it can. */
export function parseView(
  raw: string | null,
  inboxSupported: boolean,
): SidebarView {
  const views = availableViews(inboxSupported);
  return views.find((v) => v.id === raw)?.id ?? views[0]!.id;
}

/**
 * The rows in each view, before the repo filter and the search. A count is
 * null until the data of its view has loaded.
 */
export function viewCounts(
  pulls: readonly InboxPull[] | null,
  sessions: readonly SessionSummary[] | null,
): ViewCounts {
  const counts: ViewCounts = {
    reviewRequested: null,
    authored: null,
    involved: null,
    guided: sessions ? latestRunPerPull(sessions).length : null,
  };
  if (pulls)
    for (const g of INBOX_GROUPS)
      counts[g.id] = pulls.filter((p) => p.groups.includes(g.id)).length;
  return counts;
}

/** A count for display: a dash while it loads, never a false 0. */
export function formatCount(count: number | null): string {
  return count === null ? "–" : String(count);
}

/** The repositories of a view, sorted by name, before any filter. */
export function viewRepos(
  view: SidebarView,
  pulls: readonly InboxPull[] | null,
  sessions: readonly SessionSummary[] | null,
): string[] {
  const names = isInboxView(view)
    ? (pulls ?? []).filter((p) => p.groups.includes(view)).map(repoName)
    : (sessions ?? []).map(repoName);
  return [...new Set(names)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/** A repo filter that still names a repository of the view, else null. */
export function keepRepo(repos: readonly string[], repo: string | null) {
  return repo && repos.includes(repo) ? repo : null;
}

/**
 * The rows of a view that pass the filter, grouped by repository. Pulls are
 * newest first; sessions keep the server's order, one per pull request.
 * Groups come in the order of their first row.
 */
export function viewRows(
  view: SidebarView,
  pulls: readonly InboxPull[] | null,
  sessions: readonly SessionSummary[] | null,
  filter: ViewFilter,
): ViewRows {
  if (isInboxView(view))
    return {
      kind: "pulls",
      groups: groupByRepo(filterInbox(pulls ?? [], { group: view, ...filter })),
    };
  const rows = latestRunPerPull(sessions ?? []).filter(
    (s) =>
      (!filter.repo || repoName(s) === filter.repo) &&
      matchesQuery(s, filter.query),
  );
  return { kind: "sessions", groups: groupByRepo(rows) };
}

/**
 * The view that shows `repo`: the current one if it does, else the guided
 * reviews, else the first inbox view that does. The current view when none
 * does.
 */
export function viewForRepo(
  current: SidebarView,
  pulls: readonly InboxPull[] | null,
  sessions: readonly SessionSummary[] | null,
  repo: string,
  inboxSupported: boolean,
): SidebarView {
  const target = repo.toLowerCase();
  const shows = (view: SidebarView) =>
    viewRepos(view, pulls, sessions).some((r) => r.toLowerCase() === target);
  if (shows(current)) return current;
  const order: SidebarView[] = ["guided", ...INBOX_GROUPS.map((g) => g.id)];
  const ids = new Set(availableViews(inboxSupported).map((v) => v.id));
  return order.find((v) => ids.has(v) && shows(v)) ?? current;
}

function groupByRepo<T extends { repo: { owner: string; repo: string } }>(
  items: readonly T[],
): ViewGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const repo = repoName(item);
    const list = groups.get(repo);
    if (list) list.push(item);
    else groups.set(repo, [item]);
  }
  return [...groups].map(([repo, list]) => ({ repo, items: list }));
}
