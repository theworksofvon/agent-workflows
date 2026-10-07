import { createContext, useContext } from "react";
import type {
  ApiFinding,
  FindingVerdict,
  HumanComment,
  Verdict,
} from "../types";

/** A finding the page scrolls to and highlights after a jump. */
export interface FocusTarget {
  findingId: string;
  path: string;
}

/**
 * A move from the overview to another tab. The page records `label` for the
 * "Back to Overview" pill, and scrolls to `focus` when one is given.
 */
export type Jump = (label: string, href: string, focus?: FocusTarget) => void;

/** What a file diff needs from the session page, without prop drilling. */
export interface ReviewActions {
  focus: FocusTarget | null;
  findingsFor(path: string): ApiFinding[];
  commentsFor(path: string): HumanComment[];
  verdictFor(findingId: string): FindingVerdict | undefined;
  isViewed(path: string): boolean;
  setViewed(path: string, viewed: boolean): void;
  setVerdict(findingId: string, verdict: Verdict | null, note: string): void;
  addComment(path: string, line: number, body: string): Promise<boolean>;
  deleteComment(commentId: string): void;
}

export const ReviewContext = createContext<ReviewActions | null>(null);

export function useReview(): ReviewActions {
  const actions = useContext(ReviewContext);
  if (!actions) throw new Error("useReview needs a ReviewContext provider");
  return actions;
}
