export type SessionTab = "overview" | "guide" | "diff";

export type Route =
  | { page: "home" }
  | { page: "session"; id: string; tab: SessionTab; chapter: string | null }
  | { page: "pull"; owner: string; repo: string; number: number };

export const TABS: readonly SessionTab[] = ["overview", "guide", "diff"];

/**
 * Hash routes: `#/`, `#/s/:id`, `#/s/:id/:tab`, `#/s/:id/guide/:chapter`,
 * and `#/pr/:owner/:repo/:number` for a pull request without a review.
 */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "pr" && parts[1] && parts[2] && /^\d+$/.test(parts[3] ?? ""))
    return {
      page: "pull",
      owner: decodeURIComponent(parts[1]),
      repo: decodeURIComponent(parts[2]),
      number: Number(parts[3]),
    };
  if (parts[0] === "s" && parts[1]) {
    const tab = TABS.includes(parts[2] as SessionTab)
      ? (parts[2] as SessionTab)
      : "overview";
    return {
      page: "session",
      id: decodeURIComponent(parts[1]),
      tab,
      chapter: parts[3] ? decodeURIComponent(parts[3]) : null,
    };
  }
  return { page: "home" };
}

export function sessionHref(
  id: string,
  tab: SessionTab = "overview",
  chapter?: string | null,
): string {
  const base = `#/s/${encodeURIComponent(id)}`;
  if (tab === "overview" && !chapter) return base;
  return chapter
    ? `${base}/${tab}/${encodeURIComponent(chapter)}`
    : `${base}/${tab}`;
}

export function pullHref(owner: string, repo: string, number: number): string {
  return `#/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
}

export function navigate(href: string): void {
  window.location.hash = href.replace(/^#/, "");
}
