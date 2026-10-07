import {
  UnknownAccountError,
  type GitHubAccountsPort,
} from "../adapters/github/accounts.js";
import type { GitHubPort } from "../adapters/github/github.interface.js";
import { RateLimitedError } from "../domain/errors.js";
import type { SettingsStore } from "../adapters/state/settings.js";
import type { RepoRef } from "../domain/pull-request.js";
import {
  checksRollup,
  dedupeChecks,
  INBOX_GROUPS,
  INBOX_QUERIES,
  mergeInbox,
  type Account,
  type Check,
  type ChecksRollup,
  type InboxGroup,
  type InboxPull,
} from "../domain/inbox.js";

export type AccountClient = Pick<
  GitHubPort,
  | "searchPullRequests"
  | "listRepoPullRequests"
  | "getPullRequestDetail"
  | "getPullRequestChecks"
  | "listPullRequestFiles"
  | "createPullRequestReview"
>;

export interface Checks {
  rollup: ChecksRollup;
  checks: Check[];
  headSha: string;
  fetchedAt: string;
  /** More checks exist than were read; the rollup still counts them. */
  truncated: boolean;
}

export interface Inbox {
  pulls: InboxPull[];
  fetchedAt: string;
  /** Per group: GitHub matched more PRs than INBOX_PAGE. */
  truncated: Record<InboxGroup, boolean>;
  /** Errors GitHub returned beside partial results. */
  warnings: string[];
  /** A rate limit hit, so this is the last inbox fetched. */
  stale: boolean;
}

/** GitHub as each account sees it, with the UI's current account. */
export interface GitHubAccess {
  accounts(): Promise<{ accounts: Account[]; current: string }>;
  current(): Promise<string>;
  /** Throws UnknownAccountError for a login that is not an account. */
  setCurrent(login: string): Promise<string>;
  /**
   * The given account, or the current one for an empty login. Throws
   * UnknownAccountError for a login that is not an account.
   */
  resolve(login: string): Promise<string>;
  use(
    login: string,
  ): Promise<{ login: string; token: string; client: AccountClient }>;
  /**
   * Pulls carry a null sessionId; the caller fills it. After a rate limit
   * the last inbox returns with `stale`, and a refresh waits RATE_LIMIT_BACKOFF_MS.
   */
  inbox(login: string, refresh: boolean): Promise<Inbox>;
  checks(login: string, repo: RepoRef, prNumber: number): Promise<Checks>;
}

export const CURRENT_ACCOUNT_KEY = "ui.account";
export const INBOX_CACHE_MS = 60_000;
export const CHECKS_CACHE_MS = 20_000;
export const INBOX_PAGE = 50;
export const RATE_LIMIT_BACKOFF_MS = 60_000;

export function githubAccess(args: {
  accounts: GitHubAccountsPort;
  settings: SettingsStore;
  createClient(token: string): AccountClient;
  now?: () => Date;
}): GitHubAccess {
  const { accounts, settings } = args;
  const now = args.now ?? (() => new Date());
  const clients = new Map<string, AccountClient>();
  const inboxes = ttlCache<Inbox>(INBOX_CACHE_MS, now);
  /** The newest inbox per account, kept past the cache for a rate limit. */
  const lastInbox = new Map<string, Inbox>();
  const backoffUntil = new Map<string, number>();
  const checkCache = ttlCache<Checks>(CHECKS_CACHE_MS, now);

  const known = async (login: string): Promise<boolean> =>
    (await accounts.list()).some((a) => a.login === login);

  const current = async (): Promise<string> => {
    const stored = settings.get(CURRENT_ACCOUNT_KEY);
    if (stored !== null && (await known(stored))) return stored;
    return accounts.active();
  };

  const resolve = async (login: string): Promise<string> => {
    if (login === "") return current();
    if (!(await known(login)))
      throw new UnknownAccountError(`unknown GitHub account: ${login}`);
    return login;
  };

  const use = async (login: string) => {
    const resolved = await resolve(login);
    const token = await accounts.token(resolved);
    let client = clients.get(token);
    if (!client) {
      client = args.createClient(token);
      clients.set(token, client);
    }
    return { login: resolved, token, client };
  };

  const fetchInbox = async (login: string): Promise<Inbox> => {
    const { client } = await use(login);
    const [reviewRequested, authored, involved] = await Promise.all(
      INBOX_GROUPS.map((group) =>
        client.searchPullRequests(INBOX_QUERIES[group], INBOX_PAGE),
      ),
    );
    return {
      pulls: mergeInbox({
        reviewRequested: reviewRequested.pulls,
        authored: authored.pulls,
        involved: involved.pulls,
      }),
      fetchedAt: now().toISOString(),
      truncated: {
        reviewRequested: reviewRequested.truncated,
        authored: authored.truncated,
        involved: involved.truncated,
      },
      warnings: [
        ...new Set(
          [reviewRequested, authored, involved].flatMap((s) => s.warnings),
        ),
      ],
      stale: false,
    };
  };

  return {
    async accounts() {
      return { accounts: await accounts.list(), current: await current() };
    },

    current,

    async setCurrent(login) {
      const resolved = await resolve(login);
      settings.set(CURRENT_ACCOUNT_KEY, resolved);
      return resolved;
    },

    resolve,

    use,

    async inbox(login, refresh) {
      const backingOff = (backoffUntil.get(login) ?? 0) > now().getTime();
      const cached = refresh && !backingOff ? null : inboxes.get(login);
      if (cached) return cached;
      const last = lastInbox.get(login);
      if (backingOff && last) return { ...last, stale: true };
      try {
        const value = await fetchInbox(login);
        inboxes.set(login, value);
        lastInbox.set(login, value);
        return value;
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        backoffUntil.set(login, now().getTime() + RATE_LIMIT_BACKOFF_MS);
        if (last) return { ...last, stale: true };
        throw err;
      }
    },

    async checks(login, repo, prNumber) {
      const key = `${login} ${repo.owner}/${repo.repo}#${prNumber}`;
      const cached = checkCache.get(key);
      if (cached) return cached;
      const { client } = await use(login);
      const live = await client.getPullRequestChecks(repo, prNumber);
      const checks = dedupeChecks(live.checks);
      const statuses = checks.map((c) => c.status);
      // GitHub's rollup covers the contexts past the pages that were read.
      if (live.truncated && live.overall) statuses.push(live.overall);
      const value: Checks = {
        rollup: checksRollup(statuses),
        checks,
        headSha: live.headSha,
        fetchedAt: now().toISOString(),
        truncated: live.truncated,
      };
      checkCache.set(key, value);
      return value;
    },
  };
}

/** A map whose entries expire; each write drops the expired ones. */
function ttlCache<T>(ms: number, now: () => Date) {
  const entries = new Map<string, { at: number; value: T }>();
  const live = (at: number) => now().getTime() - at < ms;
  return {
    get(key: string): T | null {
      const entry = entries.get(key);
      return entry && live(entry.at) ? entry.value : null;
    },
    set(key: string, value: T): void {
      for (const [k, entry] of entries) if (!live(entry.at)) entries.delete(k);
      entries.set(key, { at: now().getTime(), value });
    },
  };
}
