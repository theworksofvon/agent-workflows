import type { Inbox, InboxGroup, InboxPull } from "../types";
import { repoName } from "./sessions";

export const INBOX_GROUPS: readonly {
  id: InboxGroup;
  label: string;
  title: string;
}[] = [
  { id: "reviewRequested", label: "Requested", title: "Review requested" },
  { id: "authored", label: "Created", title: "Created by you" },
  { id: "involved", label: "Involved", title: "Involves you" },
];

export interface InboxFilter {
  group: InboxGroup;
  /** `owner/repo`, or null for every repository. */
  repo: string | null;
  query: string;
}

/** The pulls that match the filter, most recently updated first. */
export function filterInbox(
  pulls: readonly InboxPull[],
  filter: InboxFilter,
): InboxPull[] {
  return pulls
    .filter(
      (p) =>
        p.groups.includes(filter.group) &&
        (!filter.repo || repoName(p) === filter.repo) &&
        matchesPull(p, filter.query),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Case-insensitive match on `owner/repo`, `#number`, title, and author. */
export function matchesPull(p: InboxPull, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text =
    `${repoName(p)} #${p.number} ${p.title} ${p.author.login}`.toLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

/** The pull for `owner/repo#number`, if the inbox holds it. */
export function findPull(
  pulls: readonly InboxPull[] | null | undefined,
  owner: string,
  repo: string,
  number: number,
): InboxPull | null {
  return (
    pulls?.find(
      (p) =>
        p.number === number &&
        // An older server's repo list has no `repo` on its pulls.
        p.repo?.owner.toLowerCase() === owner.toLowerCase() &&
        p.repo?.repo.toLowerCase() === repo.toLowerCase(),
    ) ?? null
  );
}

export interface InboxNotices {
  /** The chosen group has more pulls than the server read. */
  truncated: boolean;
  warnings: string[];
  stale: boolean;
}

/** The hints that the server attached to an inbox answer. */
export function inboxNotices(
  inbox: Pick<Inbox, "truncated" | "warnings" | "stale"> | null | undefined,
  group: InboxGroup,
): InboxNotices {
  return {
    truncated: Boolean(inbox?.truncated?.[group]),
    warnings: (inbox?.warnings ?? []).filter((w) => w.trim() !== ""),
    stale: inbox?.stale === true,
  };
}
