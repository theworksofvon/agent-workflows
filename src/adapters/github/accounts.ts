import { execFile } from "node:child_process";
import type { Account } from "../../domain/inbox.js";
import { errorMessage } from "../../domain/util.js";
import { log } from "../../log.js";

/** An account gh lists; `ok` is false when gh reports its login invalid. */
export interface GitHubAccount extends Account {
  ok: boolean;
}

/** The GitHub accounts the UI can act as, with tokens that stay on the server. */
export interface GitHubAccountsPort {
  /** Every account gh lists, valid or not; never empty. */
  list(): Promise<GitHubAccount[]>;
  /** gh's active account, or the only account. */
  active(): Promise<string>;
  /**
   * Throws UnknownAccountError for a login that list() does not return, and
   * an error naming the fix for a login gh reports invalid.
   */
  token(login: string): Promise<string>;
  /** True while GITHUB_TOKEN stands in because gh is missing or has no account. */
  isFallback(): Promise<boolean>;
}

/** Runs a program without a shell and resolves with its stdout. */
export type ExecFile = (file: string, args: string[]) => Promise<string>;

export class UnknownAccountError extends Error {}

/** gh can rotate a token, so a cached one is fetched again after this. */
export const ACCOUNT_CACHE_MS = 5 * 60 * 1000;

const HOST = "github.com";
// Projects the status to logins so that no token field reaches this process.
const STATUS_ARGS = [
  "auth",
  "status",
  "--hostname",
  HOST,
  "--json",
  "hosts",
  "--jq",
  `[.hosts["${HOST}"][]? | {login, active, state}]`,
];

interface GhLogin {
  login: string;
  active: boolean;
  ok: boolean;
}

interface Snapshot {
  at: number;
  logins: GhLogin[];
  /** Set when gh had no account and GITHUB_TOKEN stands in. */
  fallback: boolean;
}

/**
 * Accounts from `gh auth status` for github.com, with each token from
 * `gh auth token --user`. Only when gh is not installed or lists no account
 * does the account that `fallbackToken` (GITHUB_TOKEN) belongs to stand in;
 * any other gh failure keeps the last list, so the account that publishes
 * never changes silently. Logins, avatars, and tokens are cached in memory;
 * no token is logged.
 */
export function ghAccounts(args: {
  /** GITHUB_TOKEN; without it, gh must list an account. */
  fallbackToken: string | undefined;
  /** GET /user with the token. */
  lookupUser(token: string): Promise<Account>;
  exec?: ExecFile;
  now?: () => number;
}): GitHubAccountsPort {
  const exec = args.exec ?? defaultExecFile;
  const now = args.now ?? Date.now;
  const avatars = new Map<string, string | null>();
  const tokens = new Map<string, { at: number; token: string }>();
  let snapshot: Snapshot | null = null;

  const fresh = (at: number) => now() - at < ACCOUNT_CACHE_MS;

  /** gh's accounts, or null when gh is not installed. */
  const fromGh = async (): Promise<GhLogin[] | null> => {
    let out: string;
    try {
      out = await exec("gh", STATUS_ARGS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const rows = JSON.parse(out) as Array<
      Omit<GhLogin, "ok"> & { state: string }
    >;
    return rows.map(({ login, active, state }) => ({
      login,
      active,
      ok: state === "success",
    }));
  };

  const fallback = async (fallbackToken: string): Promise<Snapshot> => {
    log.warn("gh has no github.com account; using GITHUB_TOKEN's account");
    const user = await args.lookupUser(fallbackToken);
    avatars.set(user.login, user.avatarUrl);
    return {
      at: now(),
      logins: [{ login: user.login, active: true, ok: true }],
      fallback: true,
    };
  };

  const load = async (): Promise<Snapshot> => {
    if (snapshot && fresh(snapshot.at)) return snapshot;
    let logins: GhLogin[] | null;
    try {
      logins = await fromGh();
    } catch (err) {
      if (!snapshot)
        throw new Error(
          `could not list GitHub accounts with gh: ${errorMessage(err)}`,
          { cause: err },
        );
      log.warn("gh accounts unavailable; keeping the last list", {
        error: errorMessage(err),
      });
      snapshot = { ...snapshot, at: now() };
      return snapshot;
    }
    if (logins !== null && logins.length > 0) {
      snapshot = { at: now(), logins, fallback: false };
      return snapshot;
    }
    if (args.fallbackToken === undefined)
      throw new Error(
        `gh has no ${HOST} account and GITHUB_TOKEN is not set; run gh auth login --hostname ${HOST} or set GITHUB_TOKEN`,
      );
    snapshot = await fallback(args.fallbackToken);
    return snapshot;
  };

  const token = async (login: string): Promise<string> => {
    const { logins, fallback: usesFallback } = await load();
    const entry = logins.find((l) => l.login === login);
    if (!entry)
      throw new UnknownAccountError(`unknown GitHub account: ${login}`);
    if (!entry.ok)
      throw new Error(
        `gh reports the login for ${login} as invalid; run gh auth login --hostname ${HOST} again for that account`,
      );
    // A fallback snapshot exists only when fallbackToken is set.
    if (usesFallback) return args.fallbackToken as string;
    const cached = tokens.get(login);
    if (cached && fresh(cached.at)) return cached.token;
    const value = (
      await exec("gh", ["auth", "token", "--hostname", HOST, "--user", login])
    ).trim();
    if (value === "")
      throw new Error(`gh auth token returned no token for ${login}`);
    tokens.set(login, { at: now(), token: value });
    return value;
  };

  const avatar = async (entry: GhLogin): Promise<string | null> => {
    const { login } = entry;
    if (avatars.has(login)) return avatars.get(login) ?? null;
    if (!entry.ok) return null;
    try {
      const user = await args.lookupUser(await token(login));
      avatars.set(login, user.avatarUrl);
      return user.avatarUrl;
    } catch (err) {
      log.warn("could not look up a GitHub avatar", {
        login,
        error: errorMessage(err),
      });
      return null;
    }
  };

  return {
    async list() {
      const { logins } = await load();
      return Promise.all(
        logins.map(async (entry) => ({
          login: entry.login,
          avatarUrl: await avatar(entry),
          ok: entry.ok,
        })),
      );
    },

    async active() {
      const { logins } = await load();
      return (logins.find((l) => l.active) ?? logins[0]).login;
    },

    token,

    async isFallback() {
      return (await load()).fallback;
    },
  };
}

const GH_TIMEOUT_MS = 15_000;

/**
 * gh treats a token in these variables as the active account and hides the
 * keyring accounts behind it, and the app's .env sets GITHUB_TOKEN.
 */
const GH_TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

export const defaultExecFile: ExecFile = (file, args) => {
  const env = { ...process.env };
  for (const name of GH_TOKEN_VARIABLES) delete env[name];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: GH_TIMEOUT_MS, encoding: "utf8", env },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
};
