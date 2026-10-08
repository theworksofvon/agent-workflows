import { UnknownAccountError } from "../adapters/github/accounts.js";
import type {
  HumanState,
  PrSnapshot,
  ReviewSession,
  ReviewSessionStore,
  Verdict,
} from "../adapters/state/review-sessions.js";
import { findingId, type ReviewFinding } from "../domain/decisions.js";
import { DomainError } from "../domain/errors.js";
import type { RepoRef } from "../domain/pull-request.js";
import type { Triage } from "../domain/triage.js";
import {
  composeReview,
  type ComposedReview,
  type ReviewEvent,
} from "../domain/publish.js";
import { parseReviewTarget } from "../domain/target.js";
import type {
  InboxPull,
  PullCard,
  PullDetail,
  PullState,
} from "../domain/inbox.js";
import type { Checks, GitHubAccess } from "./github-access.js";
import { focusStore, parseFocus, type Focus } from "./focus.js";
import type { ReviewEvents } from "./review-events.js";
import {
  T3InputError,
  T3NotConnectedError,
  type T3Link,
  type T3Status,
  type T3Thread,
} from "./t3-link.js";

export class NotFoundError extends DomainError {}
export class BadRequestError extends DomainError {}
export class ConflictError extends DomainError {}
/** T3 failed or could not be reached. */
export class BadGatewayError extends DomainError {}

export interface ReviewApiPorts {
  sessions: ReviewSessionStore;
  github: GitHubAccess;
  /** Runs a guided review for the session; never awaited by a request. */
  startRun(sessionId: string): Promise<void>;
  agent: string;
  events: ReviewEvents;
  t3: T3Link;
}

export interface SessionSummary {
  id: string;
  repo: RepoRef;
  prNumber: number;
  title: string | null;
  author: string | null;
  status: ReviewSession["status"];
  stage: string;
  triage: Triage | null;
  createdAt: string;
  updatedAt: string;
  counts: { files: number; findings: number; chapters: number };
  account: string;
  authorAvatarUrl: string | null;
  state: PullState;
  /** Chapters of the guide marked reviewed. */
  reviewedChapters: number;
}

export type IdentifiedFinding = ReviewFinding & { id: string };

export type ReviewApi = ReturnType<typeof reviewApi>;

const LIST_LIMIT = 100;
const EVENTS: readonly ReviewEvent[] = [
  "COMMENT",
  "APPROVE",
  "REQUEST_CHANGES",
];
const VERDICTS: readonly Verdict[] = ["agree", "disagree", "unsure"];
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const REPO_PULLS_PAGE = 50;

/**
 * The guided review operations behind the HTTP routes. Bodies arrive as
 * untrusted JSON, so every operation validates its own input.
 */
export function reviewApi(ports: ReviewApiPorts) {
  const { sessions, github, events } = ports;
  const publishing = new Map<string, Promise<unknown>>();
  const focus = focusStore();

  const session = (id: string): ReviewSession => {
    const found = sessions.get(id);
    if (!found) throw new NotFoundError(`review session not found: ${id}`);
    return found;
  };

  const start = (
    repo: RepoRef,
    prNumber: number,
    account: string,
    carryFrom?: string,
  ): { id: string } => {
    const created = sessions.create({
      repo,
      prNumber,
      agent: ports.agent,
      account,
    });
    if (carryFrom !== undefined) carryHumanState(carryFrom, created.id);
    void ports.startRun(created.id);
    return { id: created.id };
  };

  /*
   * Verdicts are keyed by finding id, so a verdict applies again only when
   * the new run reports the identical finding. Marks and comments copy as
   * they are; a comment off the new diff publishes in the review body.
   */
  const carryHumanState = (fromId: string, toId: string): void => {
    const from = sessions.human(fromId);
    for (const chapterId of Object.keys(from.chapters))
      sessions.setChapterReviewed(toId, chapterId, true);
    for (const path of Object.keys(from.files))
      sessions.setFileViewed(toId, path, true);
    for (const [key, entry] of Object.entries(from.verdicts))
      sessions.setVerdict(toId, key, entry.verdict, entry.note);
    for (const c of from.comments)
      sessions.addComment(toId, { path: c.path, line: c.line, body: c.body });
  };

  const human = (id: string): { human: HumanState } => ({
    human: sessions.human(id),
  });

  /** The human state after a write, which every open page then reloads. */
  const changed = (id: string): { human: HumanState } => {
    events.changed(id);
    return human(id);
  };

  /** An unknown login is the caller's mistake, so it is a 400. */
  const account = async (login: string): Promise<string> => {
    try {
      return await github.resolve(login);
    } catch (err) {
      if (err instanceof UnknownAccountError)
        throw new BadRequestError(err.message);
      throw err;
    }
  };

  /**
   * A session stored before sessions had an account must not act as
   * whichever account is current now.
   */
  const sessionAccount = async (found: ReviewSession): Promise<string> => {
    if (found.account === "")
      throw new ConflictError(
        "choose the account for this review: it was stored without one",
      );
    return account(found.account);
  };

  /** A session whose PR and account a T3 thread can name. */
  const t3Ready = async (id: string): Promise<ReviewSession> => {
    const found = session(id);
    requireReady(found);
    await sessionAccount(found);
    return found;
  };

  const withSession = <T extends PullCard>(
    pull: T,
    groups: InboxPull["groups"] = [],
  ): T & Pick<InboxPull, "groups" | "sessionId"> => ({
    ...pull,
    groups,
    sessionId: sessions.latestId(pull.repo, pull.number),
  });

  const compose = (
    found: ReviewSession,
    pr: PrSnapshot,
    event: ReviewEvent,
  ): ComposedReview =>
    composeReview({
      session: found,
      human: sessions.human(found.id),
      event,
      files: pr.files,
    });

  return {
    health() {
      return { ok: true as const, agent: ports.agent };
    },

    listSessions(): { sessions: SessionSummary[] } {
      return {
        sessions: sessions
          .list(LIST_LIMIT)
          .map((s) => summarize(s, sessions.human(s.id))),
      };
    },

    /** `account` defaults to the current account. */
    async createSession(body: unknown): Promise<{ id: string }> {
      const target = field(body, "target");
      if (typeof target !== "string")
        throw new BadRequestError("target must be a string");
      const login = field(body, "account") ?? "";
      if (typeof login !== "string")
        throw new BadRequestError("account must be a string");
      let parsed;
      try {
        parsed = parseReviewTarget(target);
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
      return start(parsed.repo, parsed.prNumber, await account(login));
    },

    getSession(id: string): {
      session: ReviewSession;
      human: HumanState;
      findings: IdentifiedFinding[];
    } {
      const found = session(id);
      return { session: found, ...human(id), findings: identified(found) };
    },

    /**
     * Starts a new run for the same PR as the same account and carries the
     * human state over. `account` in the body chooses the account for a
     * session stored without one.
     */
    async rerun(id: string, body: unknown = {}): Promise<{ id: string }> {
      const found = session(id);
      if (found.status !== "ready" && found.status !== "failed")
        throw new ConflictError(
          `the session is still running (status ${found.status})`,
        );
      const chosen = field(body, "account") ?? "";
      if (typeof chosen !== "string")
        throw new BadRequestError("account must be a string");
      const login =
        found.account === "" && chosen !== ""
          ? await account(chosen)
          : await sessionAccount(found);
      return start(found.repo, found.prNumber, login, found.id);
    },

    setChapter(id: string, chapterId: string, body: unknown) {
      session(id);
      sessions.setChapterReviewed(id, chapterId, flag(body, "reviewed"));
      return changed(id);
    },

    setFile(id: string, body: unknown) {
      session(id);
      const path = text(body, "path");
      sessions.setFileViewed(id, path, flag(body, "viewed"));
      return changed(id);
    },

    setVerdict(id: string, findingKey: string, body: unknown) {
      const found = session(id);
      if (!identified(found).some((f) => f.id === findingKey))
        throw new NotFoundError(`finding not found: ${findingKey}`);
      const verdict = field(body, "verdict");
      if (verdict !== null && !VERDICTS.includes(verdict as Verdict))
        throw new BadRequestError(
          "verdict must be agree, disagree, unsure, or null",
        );
      const note = field(body, "note") ?? "";
      if (typeof note !== "string")
        throw new BadRequestError("note must be a string");
      sessions.setVerdict(id, findingKey, verdict as Verdict | null, note);
      return changed(id);
    },

    addComment(id: string, body: unknown) {
      const found = session(id);
      const path = text(body, "path");
      const line = field(body, "line");
      const comment = text(body, "body").trim();
      if (!found.pr?.files.some((f) => f.path === path))
        throw new BadRequestError(`${path} is not a file in this PR`);
      if (!Number.isInteger(line) || (line as number) < 1)
        throw new BadRequestError("line must be a positive integer");
      if (comment === "") throw new BadRequestError("comment body is empty");
      sessions.addComment(id, { path, line: line as number, body: comment });
      return changed(id);
    },

    deleteComment(id: string, commentId: string) {
      session(id);
      if (!sessions.deleteComment(id, commentId))
        throw new NotFoundError(`comment not found: ${commentId}`);
      return changed(id);
    },

    previewPublish(
      id: string,
      event: string | null,
    ): { preview: ComposedReview } {
      const found = session(id);
      const pr = requireReady(found);
      return { preview: compose(found, pr, reviewEvent(event ?? "COMMENT")) };
    },

    /** The only operation that writes to GitHub, and only with confirm: true. */
    async publish(
      id: string,
      body: unknown,
    ): Promise<{ ok: true; publishedAt: string }> {
      if (field(body, "confirm") !== true)
        throw new BadRequestError("publishing requires confirm: true");
      const event = reviewEvent(field(body, "event"));
      const found = session(id);
      const pr = requireReady(found);
      if (found.publishedAt !== null)
        throw new ConflictError(`already published at ${found.publishedAt}`);
      if (publishing.has(id))
        throw new ConflictError("a publish is already in progress");
      const run = (async () => {
        const review = compose(found, pr, event);
        const { client } = await github.use(await sessionAccount(found));
        await client.createPullRequestReview({
          repo: found.repo,
          prNumber: found.prNumber,
          body: review.body,
          comments: review.comments,
          event,
          commitId: pr.headSha,
        });
        const publishedAt = new Date().toISOString();
        sessions.update(id, { publishedAt });
        events.changed(id);
        return { ok: true as const, publishedAt };
      })();
      publishing.set(id, run);
      try {
        return await run;
      } finally {
        publishing.delete(id);
      }
    },

    /** Resolves once every publish in flight has finished. */
    async settled(): Promise<void> {
      await Promise.allSettled([...publishing.values()]);
    },

    /**
     * Records the account of a session stored without one; publish and
     * re-run refuse such a session until then.
     */
    async setSessionAccount(
      id: string,
      body: unknown,
    ): Promise<{ account: string }> {
      const found = session(id);
      const login = text(body, "login");
      if (login === "") throw new BadRequestError("login must not be empty");
      const resolved = await account(login);
      if (found.account !== "" && found.account !== resolved)
        throw new ConflictError(
          `the review already belongs to ${found.account}`,
        );
      sessions.update(id, { account: resolved });
      return { account: resolved };
    },

    /** Stops when the returned call runs. */
    subscribe(id: string, listener: () => void): () => void {
      session(id);
      return events.subscribe(id, listener);
    },

    setFocus(body: unknown): { focus: Focus } {
      const found = session(text(body, "review"));
      const parsed = parseFocus(body as Record<string, unknown>);
      if (typeof parsed === "string") throw new BadRequestError(parsed);
      return { focus: focus.set(found, parsed) };
    },

    getFocus(): { focus: Focus | null } {
      return { focus: focus.get() };
    },

    t3Status(): T3Status {
      return ports.t3.status();
    },

    t3Connect(body: unknown): Promise<{ authorizeUrl: string }> {
      return t3(() => ports.t3.connect(object(body)));
    },

    t3Callback(query: URLSearchParams): Promise<void> {
      return t3(() => ports.t3.callback(query));
    },

    t3Disconnect(): T3Status {
      return ports.t3.disconnect();
    },

    /** Opens the T3 thread of this account's review of the PR. */
    async openInT3(id: string): Promise<{ thread: T3Thread }> {
      const found = await t3Ready(id);
      return { thread: await t3(() => ports.t3.openThread(found)) };
    },

    async ask(id: string, body: unknown): Promise<{ thread: T3Thread }> {
      const found = await t3Ready(id);
      return { thread: await t3(() => ports.t3.ask(found, object(body))) };
    },

    discuss(id: string): { prompt: string } {
      const found = session(id);
      if (!found.pr)
        throw new ConflictError("the session has no pull request details yet");
      return { prompt: discussPrompt(found, found.pr, sessions.human(id)) };
    },

    /** Open PRs of a repository, as the current account sees them. */
    async listPulls(
      owner: string,
      repo: string,
    ): Promise<{ pulls: InboxPull[] }> {
      const ref = repoRef(owner, repo);
      const { client } = await github.use("");
      const pulls = await client.listRepoPullRequests(ref, REPO_PULLS_PAGE);
      return { pulls: pulls.map((p) => withSession(p)) };
    },

    /** The PR preview: a list row plus the body, head commit, and fork flag. */
    async getPull(
      owner: string,
      repo: string,
      number: string,
    ): Promise<{ pull: InboxPull & PullDetail }> {
      const ref = repoRef(owner, repo);
      const { client } = await github.use("");
      const detail = await client.getPullRequestDetail(ref, prNumber(number));
      return { pull: withSession(detail) };
    },

    accounts() {
      return github.accounts();
    },

    async setCurrentAccount(body: unknown): Promise<{ current: string }> {
      const login = text(body, "login");
      if (login === "") throw new BadRequestError("login must not be empty");
      await account(login);
      return { current: await github.setCurrent(login) };
    },

    /** `refresh` skips the 60 s cache. */
    async inbox(refresh: boolean) {
      const login = await github.current();
      const found = await github.inbox(login, refresh);
      return {
        account: login,
        viewer: login,
        pulls: found.pulls.map((p) => withSession(p, p.groups)),
        fetchedAt: found.fetchedAt,
        truncated: found.truncated,
        warnings: found.warnings,
        stale: found.stale,
      };
    },

    /** Checks on the PR's head commit, as the session's account. */
    async sessionChecks(id: string): Promise<Checks> {
      const found = session(id);
      const login = await account(found.account);
      return github.checks(login, found.repo, found.prNumber);
    },

    async pullChecks(
      owner: string,
      repo: string,
      number: string,
    ): Promise<Checks> {
      const ref = repoRef(owner, repo);
      return github.checks(await github.current(), ref, prNumber(number));
    },
  };
}

/** Maps a T3 failure to the HTTP status the reviewer's request deserves. */
async function t3<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof T3NotConnectedError)
      throw new ConflictError(err.message);
    if (err instanceof T3InputError) throw new BadRequestError(err.message);
    if (err instanceof DomainError) throw new BadGatewayError(err.message);
    throw err;
  }
}

function object(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

function repoRef(owner: string, repo: string): RepoRef {
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo))
    throw new BadRequestError(`invalid repository: ${owner}/${repo}`);
  return { owner, repo };
}

function prNumber(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1)
    throw new BadRequestError(`invalid pull request number: ${value}`);
  return n;
}

function summarize(s: ReviewSession, human: HumanState): SessionSummary {
  const chapters = s.guide.value?.chapters ?? [];
  return {
    id: s.id,
    repo: s.repo,
    prNumber: s.prNumber,
    title: s.pr?.title ?? null,
    author: s.pr?.author ?? null,
    status: s.status,
    stage: s.stage,
    triage: s.triage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    counts: {
      files: s.pr?.files.length ?? 0,
      findings: s.review.value?.findings.length ?? 0,
      chapters: chapters.length,
    },
    account: s.account,
    authorAvatarUrl: s.pr?.authorAvatarUrl ?? null,
    state: s.pr?.state ?? "open",
    reviewedChapters: chapters.filter((c) => human.chapters[c.id]).length,
  };
}

function identified(s: ReviewSession): IdentifiedFinding[] {
  return (s.review.value?.findings ?? []).map((f) => ({
    ...f,
    id: findingId(f),
  }));
}

function requireReady(s: ReviewSession): PrSnapshot {
  if (s.status !== "ready" || !s.pr)
    throw new ConflictError(`the session is not ready (status ${s.status})`);
  return s.pr;
}

function reviewEvent(value: unknown): ReviewEvent {
  if (!EVENTS.includes(value as ReviewEvent))
    throw new BadRequestError(`event must be one of ${EVENTS.join(", ")}`);
  return value as ReviewEvent;
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function text(body: unknown, key: string): string {
  const value = field(body, key);
  if (typeof value !== "string")
    throw new BadRequestError(`${key} must be a string`);
  return value;
}

function flag(body: unknown, key: string): boolean {
  const value = field(body, key);
  if (typeof value !== "boolean")
    throw new BadRequestError(`${key} must be a boolean`);
  return value;
}

function discussPrompt(
  s: ReviewSession,
  pr: PrSnapshot,
  human: HumanState,
): string {
  const guide = s.guide.value;
  const findings = identified(s).map((f) => {
    const entry = human.verdicts[f.id];
    const verdict = entry
      ? `${entry.verdict}${entry.note ? ` (${entry.note})` : ""}`
      : "none";
    return `- [${f.id}] ${f.path}:${f.line} (${f.severity}) ${f.body.replace(/\n[\s\S]*/, "")} — my verdict: ${verdict}`;
  });
  return [
    `Help me review ${s.repo.owner}/${s.repo.repo}#${s.prNumber} (${pr.url}). Check out branch ${pr.headRef} (base ${pr.baseRef}) in a worktree. Here is the guide:`,
    "",
    guide?.overview.context ?? "(no guide)",
    "",
    ...(guide?.chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.summary}`) ??
      []),
    "",
    "Agent findings:",
    ...(findings.length ? findings : ["(none)"]),
    "",
    "Answer my questions about this change; do not post to GitHub.",
  ].join("\n");
}
