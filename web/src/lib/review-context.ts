import { createContext, useContext } from "react";
import type {
  ApiFinding,
  FindingVerdict,
  HumanComment,
  Verdict,
} from "../types";

/**
 * What the page scrolls to after a jump: a finding, which flashes, or a
 * line range, which stays highlighted until the next jump.
 */
export type FocusTarget =
  | { findingId: string; path: string }
  | {
      path: string;
      lines: { start: number; end: number };
      /** The flow step that names these lines, shown above them. */
      label: string;
    };

/**
 * A move from the overview to another tab. The page records `label` for the
 * "Back to Overview" pill, and scrolls to `focus` when one is given.
 */
export type Jump = (label: string, href: string, focus?: FocusTarget) => void;

/** What a file diff needs from the session page, without prop drilling. */
export interface ReviewActions {
  focus: FocusTarget | null;
  clearFocus(): void;
  findingsFor(path: string): ApiFinding[];
  commentsFor(path: string): HumanComment[];
  verdictFor(findingId: string): FindingVerdict | undefined;
  isViewed(path: string): boolean;
  setViewed(path: string, viewed: boolean): void;
  setVerdict(findingId: string, verdict: Verdict | null, note: string): void;
  addComment(path: string, line: number, body: string): Promise<boolean>;
  deleteComment(commentId: string): void;
  /** Opens the Ask box; null when T3 is not connected. */
  askAbout: ((target: AskTarget) => void) | null;
}

/** What a question to the T3 thread is about. */
export interface AskTarget {
  path?: string;
  lines?: { start: number; end: number };
  finding?: string;
}

export const ReviewContext = createContext<ReviewActions | null>(null);

export function useReview(): ReviewActions {
  const actions = useContext(ReviewContext);
  if (!actions) throw new Error("useReview needs a ReviewContext provider");
  return actions;
}
