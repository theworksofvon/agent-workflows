import type {
  Accounts,
  Checks,
  ComposedReview,
  Health,
  Inbox,
  InboxPull,
  PullDetail,
  HumanState,
  OpenPull,
  ReviewEvent,
  SessionDetail,
  SessionSummary,
  Verdict,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),

  listSessions: () =>
    request<{ sessions: SessionSummary[] }>("GET", "/api/sessions").then(
      (r) => r.sessions,
    ),

  /** `account` defaults to the current account on the server. */
  createSession: (target: string, account?: string) =>
    request<{ id: string }>(
      "POST",
      "/api/sessions",
      account ? { target, account } : { target },
    ).then((r) => r.id),

  getSession: (id: string) =>
    request<SessionDetail>("GET", `/api/sessions/${enc(id)}`),

  rerun: (id: string) =>
    request<{ id: string }>("POST", `/api/sessions/${enc(id)}/rerun`).then(
      (r) => r.id,
    ),

  setChapterReviewed: (id: string, chapterId: string, reviewed: boolean) =>
    humanOf(
      request<{ human: HumanState }>(
        "PUT",
        `/api/sessions/${enc(id)}/chapters/${enc(chapterId)}`,
        { reviewed },
      ),
    ),

  setFileViewed: (id: string, path: string, viewed: boolean) =>
    humanOf(
      request<{ human: HumanState }>("PUT", `/api/sessions/${enc(id)}/files`, {
        path,
        viewed,
      }),
    ),

  setVerdict: (
    id: string,
    findingId: string,
    verdict: Verdict | null,
    note: string,
  ) =>
    humanOf(
      request<{ human: HumanState }>(
        "PUT",
        `/api/sessions/${enc(id)}/findings/${enc(findingId)}`,
        { verdict, note },
      ),
    ),

  addComment: (id: string, path: string, line: number, body: string) =>
    humanOf(
      request<{ human: HumanState }>(
        "POST",
        `/api/sessions/${enc(id)}/comments`,
        { path, line, body },
      ),
    ),

  deleteComment: (id: string, commentId: string) =>
    humanOf(
      request<{ human: HumanState }>(
        "DELETE",
        `/api/sessions/${enc(id)}/comments/${enc(commentId)}`,
      ),
    ),

  publishPreview: (id: string, event: ReviewEvent) =>
    request<{ preview: ComposedReview }>(
      "GET",
      `/api/sessions/${enc(id)}/publish?event=${enc(event)}`,
    ).then((r) => r.preview),

  publish: (id: string, event: ReviewEvent) =>
    request<{ ok: true; publishedAt: string }>(
      "POST",
      `/api/sessions/${enc(id)}/publish`,
      { event, confirm: true },
    ).then((r) => r.publishedAt),

  discussPrompt: (id: string) =>
    request<{ prompt: string }>("GET", `/api/sessions/${enc(id)}/discuss`).then(
      (r) => r.prompt,
    ),

  listOpenPulls: (owner: string, repo: string) =>
    api.listRepoPulls(owner, repo).then((pulls) => pulls.map(toOpenPull)),

  listRepoPulls: (owner: string, repo: string) =>
    request<{ pulls: InboxPull[] }>(
      "GET",
      `/api/repos/${enc(owner)}/${enc(repo)}/pulls`,
    ).then((r) => r.pulls),

  getAccounts: () => request<Accounts>("GET", "/api/accounts"),

  setCurrentAccount: (login: string) =>
    request<{ current: string }>("PUT", "/api/accounts/current", {
      login,
    }).then((r) => r.current),

  getInbox: (refresh = false) =>
    request<Inbox>("GET", refresh ? "/api/inbox?refresh=1" : "/api/inbox"),

  getChecks: (id: string) =>
    request<Checks>("GET", `/api/sessions/${enc(id)}/checks`),

  getPull: (owner: string, repo: string, number: number) =>
    request<{ pull: PullDetail }>(
      "GET",
      `/api/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`,
    ).then((r) => r.pull),

  getPullChecks: (owner: string, repo: string, number: number) =>
    request<Checks>(
      "GET",
      `/api/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/checks`,
    ),

  /** Choose the account of an old session that has none. */
  setSessionAccount: (id: string, login: string) =>
    request<unknown>("PUT", `/api/sessions/${enc(id)}/account`, { login }),
};

/** True for the 409 that asks the reader to pick the account of a session. */
export function needsAccountChoice(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    err.message.toLowerCase().includes("choose the account")
  );
}

/**
 * The value of a call to a route that an older server does not have, or
 * null when that server answers 404. A page hides the feature on null.
 */
export async function optional<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * An open pull for the repository browser. Older servers send
 * `{ author: string, draft }`; the inbox shape sends an author object and a
 * state.
 */
export function toOpenPull(
  p: InboxPull | (OpenPull & Partial<Pick<InboxPull, "state">>),
): OpenPull {
  const author = p.author as string | { login: string };
  return {
    number: p.number,
    title: p.title,
    author: typeof author === "string" ? author : author.login,
    draft: "draft" in p ? p.draft : p.state === "draft",
  };
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `${method} ${path} failed with ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

function humanOf(p: Promise<{ human: HumanState }>): Promise<HumanState> {
  return p.then((r) => r.human);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
