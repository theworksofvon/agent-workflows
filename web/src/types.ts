// Copy of the API types that the review server sends. Transcribed from the
// plan (Tasks 1, 2, 3, 5, 6) because web/ builds without the daemon sources.
// Keep in step with src/domain/{guide,triage,publish}.ts,
// src/adapters/state/review-sessions.ts and src/services/review-api.ts.

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
  severity: ReviewSeverity;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

export type ChapterRole =
  "core" | "supporting" | "config" | "data" | "tests" | "docs" | "generated";

export type FlowNodeChange = "added" | "changed" | "removed" | "unchanged";

/** Lines on the new side of a changed file that a flow step names. */
export interface CodeRef {
  path: string;
  start: number;
  end: number;
}

export interface FlowNode {
  label: string;
  change: FlowNodeChange;
  chapter: string | null;
  /** Absent in guides written before steps carried a location. */
  ref?: CodeRef | null;
}

export interface Flow {
  title: string;
  caption: string;
  before: FlowNode[];
  after: FlowNode[];
}

export interface GuideOverview {
  context: string;
  steps: string[];
  flows: Flow[];
}

export interface GuideChapter {
  id: string;
  title: string;
  role: ChapterRole;
  summary: string;
  files: string[];
}

export interface Guide {
  overview: GuideOverview;
  chapters: GuideChapter[];
}

export type ReviewDepth = "skip" | "light" | "standard" | "deep";

export interface Triage {
  depth: ReviewDepth;
  needsGuide: boolean;
  risk: number;
  engine: string;
  confidence: number | null;
  reasons: string[];
  probabilities: Record<string, Record<string, number>> | null;
}

export const RISK_LABELS: readonly string[] = [
  "Cosmetic",
  "Low",
  "Moderate",
  "High",
  "Critical",
];

export type SessionStatus =
  "queued" | "triaging" | "preparing" | "analyzing" | "ready" | "failed";

export interface PrSnapshot {
  title: string;
  body: string | null;
  author: string;
  authorAvatarUrl: string | null;
  state: PullState;
  lastCommit: LastCommit | null;
  url: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  files: PullRequestFile[];
}

export interface PartResult<T> {
  value: T | null;
  error: string | null;
}

export interface ReviewSession {
  id: string;
  repo: RepoRef;
  prNumber: number;
  status: SessionStatus;
  stage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  agent: string;
  /** The GitHub login that fetched, cloned, and publishes for this run. */
  account: string;
  pr: PrSnapshot | null;
  triage: Triage | null;
  guide: PartResult<Guide>;
  review: PartResult<ReviewResult> & { adversarial: boolean };
  publishedAt: string | null;
}

export type Verdict = "agree" | "disagree" | "unsure";

export interface FindingVerdict {
  verdict: Verdict;
  note: string;
  updatedAt: string;
}

export interface HumanComment {
  id: string;
  path: string;
  line: number;
  body: string;
  createdAt: string;
}

export interface HumanState {
  chapters: Record<string, boolean>;
  files: Record<string, boolean>;
  verdicts: Record<string, FindingVerdict>;
  comments: HumanComment[];
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface ReviewCommentDraft {
  path: string;
  line: number;
  body: string;
}

export interface ComposedReview {
  event: ReviewEvent;
  body: string;
  comments: ReviewCommentDraft[];
  skipped: {
    kind: "human" | "agent";
    path: string;
    line: number;
    reason: string;
  }[];
}

export type ApiFinding = ReviewFinding & { id: string };

export interface SessionSummary {
  id: string;
  repo: RepoRef;
  prNumber: number;
  title: string | null;
  author: string | null;
  status: SessionStatus;
  stage: string;
  triage: Triage | null;
  /** When the run started; runs of a pull request order by it. */
  createdAt?: string;
  updatedAt: string;
  counts: { files: number; findings: number; chapters: number };
  account: string;
  authorAvatarUrl: string | null;
  state: PullState;
  /** Chapters marked reviewed. */
  reviewedChapters: number;
}

export interface SessionDetail {
  session: ReviewSession;
  human: HumanState;
  findings: ApiFinding[];
}

export interface OpenPull {
  number: number;
  title: string;
  author: string;
  draft: boolean;
}

export interface Health {
  ok: true;
  agent: string;
}

// ── GitHub accounts, inbox, and checks ───────────────────

export interface Account {
  login: string;
  avatarUrl: string | null;
  /** False when the account's token no longer works. */
  ok?: boolean;
}

export interface Accounts {
  accounts: Account[];
  current: string;
}

export type PullState = "open" | "draft" | "merged" | "closed";

export type ChecksRollup = "passing" | "failing" | "pending" | null;

export type CheckStatus =
  "pending" | "success" | "failure" | "cancelled" | "skipped" | "neutral";

export interface Check {
  name: string;
  workflowName: string | null;
  status: CheckStatus;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Checks {
  rollup: ChecksRollup;
  checks: Check[];
  headSha: string;
  fetchedAt: string;
}

/** The latest commit on the head branch: who pushed it and when. */
export interface LastCommit {
  authorLogin: string | null;
  authorName: string | null;
  committedAt: string | null;
}

export type InboxGroup = "reviewRequested" | "authored" | "involved";

export interface InboxPull {
  repo: RepoRef;
  number: number;
  title: string;
  url: string;
  author: Account;
  headRef: string;
  baseRef: string;
  state: PullState;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  updatedAt: string;
  lastCommit: LastCommit | null;
  checks: ChecksRollup;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  groups: InboxGroup[];
  /** The latest guided review session for this PR (any status). */
  sessionId: string | null;
}

/** The pull request of the preview page, with its description. */
export type PullDetail = InboxPull & { body: string | null };

export interface Inbox {
  account: string;
  viewer: string;
  pulls: InboxPull[];
  fetchedAt: string;
  /** A group that has more pulls than the first 50 the server read. */
  truncated?: Partial<Record<InboxGroup, boolean>>;
  warnings?: string[];
  /** The server could not refresh and sent its cached answer. */
  stale?: boolean;
}
