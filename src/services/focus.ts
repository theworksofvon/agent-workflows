import type { ReviewSession } from "../adapters/state/review-sessions.js";

export type FocusTab = "overview" | "guide" | "diff";

/** What the reviewer has open in the app, as the page last reported it. */
export interface Focus {
  review: string;
  /** `owner/repo#number`, so an agent can check it is the review it discusses. */
  pr: string;
  account: string;
  tab: FocusTab;
  chapter: string | null;
  finding: string | null;
  path: string | null;
  lines: { start: number; end: number } | null;
  at: string;
}

export type FocusInput = Pick<
  Focus,
  "tab" | "chapter" | "finding" | "path" | "lines"
>;

const TABS: readonly FocusTab[] = ["overview", "guide", "diff"];

/**
 * The last focus only, in memory: it describes the screen now, so a restart
 * has nothing worth keeping.
 */
export function focusStore() {
  let last: Focus | null = null;
  return {
    get: (): Focus | null => last,
    set(session: ReviewSession, input: FocusInput): Focus {
      last = {
        review: session.id,
        pr: `${session.repo.owner}/${session.repo.repo}#${session.prNumber}`,
        account: session.account,
        ...input,
        at: new Date().toISOString(),
      };
      return last;
    },
  };
}

/** The focus fields of an untrusted body, or the reason they are wrong. */
export function parseFocus(body: Record<string, unknown>): FocusInput | string {
  const tab = body.tab;
  if (!TABS.includes(tab as FocusTab))
    return `tab must be one of ${TABS.join(", ")}`;
  const chapter = nullableText(body.chapter);
  const finding = nullableText(body.finding);
  const path = nullableText(body.path);
  if (chapter === undefined || finding === undefined || path === undefined)
    return "chapter, finding, and path must be strings or null";
  const lines = body.lines ?? null;
  if (lines !== null && !isRange(lines))
    return "lines must be { start, end } with 1 <= start <= end";
  return { tab: tab as FocusTab, chapter, finding, path, lines };
}

function nullableText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isRange(value: unknown): value is { start: number; end: number } {
  if (typeof value !== "object" || value === null) return false;
  const { start, end } = value as Record<string, unknown>;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 1 &&
    (end as number) >= (start as number)
  );
}
