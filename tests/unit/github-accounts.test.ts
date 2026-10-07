import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_CACHE_MS,
  defaultExecFile,
  ghAccounts,
  UnknownAccountError,
  type ExecFile,
} from "../../src/adapters/github/accounts.js";

const STATUS = JSON.stringify([
  { login: "octo-work", active: false, state: "success" },
  { login: "von", active: true, state: "success" },
  { login: "expired", active: false, state: "error" },
]);

interface Harness {
  calls: string[][];
  lookups: string[];
  advance(ms: number): void;
  accounts: ReturnType<typeof ghAccounts>;
}

function harness(
  status: () => string = () => STATUS,
  lookup: (token: string) => Promise<{
    login: string;
    avatarUrl: string | null;
  }> = async (token) => ({
    login: `user-of-${token}`,
    avatarUrl: `https://avatars.test/${token}`,
  }),
  issue: (login: string, n: number) => string = (login, n) =>
    `tok-${login}-${n}\n`,
): Harness {
  const calls: string[][] = [];
  const lookups: string[] = [];
  let ms = 0;
  let issued = 0;
  const exec: ExecFile = async (file, args) => {
    calls.push([file, ...args]);
    if (args[1] === "status") return status();
    issued += 1;
    return issue(String(args.at(-1)), issued);
  };
  const accounts = ghAccounts({
    fallbackToken: "env-token",
    exec,
    now: () => ms,
    lookupUser: (token) => {
      lookups.push(token);
      return lookup(token);
    },
  });
  return {
    calls,
    lookups,
    advance: (by) => {
      ms += by;
    },
    accounts,
  };
}

test("gh's logged-in github.com accounts list with avatars, the active one first in line", async () => {
  const h = harness();
  assert.deepEqual(await h.accounts.list(), [
    {
      login: "octo-work",
      avatarUrl: "https://avatars.test/tok-octo-work-1",
      ok: true,
    },
    { login: "von", avatarUrl: "https://avatars.test/tok-von-2", ok: true },
    // An invalid login stays listed, without an avatar lookup.
    { login: "expired", avatarUrl: null, ok: false },
  ]);
  assert.equal(await h.accounts.active(), "von");
  assert.equal(await h.accounts.isFallback(), false);
  // The status asks gh to project away every token field.
  const status = h.calls[0];
  assert.deepEqual(status.slice(0, 7), [
    "gh",
    "auth",
    "status",
    "--hostname",
    "github.com",
    "--json",
    "hosts",
  ]);
  assert.match(status[8], /\{login, active, state\}/);
  assert.deepEqual(h.calls[1], [
    "gh",
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "octo-work",
  ]);

  // Avatars are looked up once; status and tokens are cached for 5 minutes.
  await h.accounts.list();
  assert.equal(h.lookups.length, 2);
  assert.equal(h.calls.length, 3);
  assert.equal(await h.accounts.token("von"), "tok-von-2");
  h.advance(ACCOUNT_CACHE_MS);
  assert.equal(await h.accounts.token("von"), "tok-von-3");
  assert.equal(h.calls.filter((c) => c[2] === "status").length, 2);
});

test("a login that gh does not list, or lists as invalid, has no token", async () => {
  const h = harness();
  await assert.rejects(
    h.accounts.token("expired"),
    (err: Error) =>
      !(err instanceof UnknownAccountError) &&
      /gh reports the login for expired as invalid/.test(err.message),
  );
  await assert.rejects(h.accounts.token("--help"), UnknownAccountError);
  assert.ok(h.calls.every((c) => c[2] !== "token"));
});

test("an invalid active account stays active instead of another taking over", async () => {
  const h = harness(() =>
    JSON.stringify([
      { login: "other", active: false, state: "success" },
      { login: "me", active: true, state: "error" },
    ]),
  );
  assert.equal(await h.accounts.active(), "me");
  await assert.rejects(h.accounts.token("me"), /invalid/);
});

test("an empty token from gh is an error and is not cached", async () => {
  let empty = true;
  const h = harness(undefined, undefined, (login, n) =>
    empty ? "\n" : `tok-${login}-${n}`,
  );
  await assert.rejects(
    h.accounts.token("von"),
    /gh auth token returned no token for von/,
  );
  empty = false;
  assert.equal(await h.accounts.token("von"), "tok-von-2");
});

test("a gh failure other than a missing gh keeps the last list instead of switching to GITHUB_TOKEN", async () => {
  let failing = false;
  const h = harness(() => {
    if (failing) throw new Error("gh timed out");
    return STATUS;
  });
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    assert.equal(await h.accounts.active(), "von");
    failing = true;
    h.advance(ACCOUNT_CACHE_MS);
    assert.equal(await h.accounts.active(), "von");
    assert.equal(await h.accounts.isFallback(), false);
    assert.ok(warnings.some((w) => /keeping the last list/.test(w)));
    assert.ok(!h.lookups.includes("env-token"));

    for (const status of [
      () => {
        throw new Error("gh timed out");
      },
      () => "not json",
    ]) {
      const cold = harness(status);
      await assert.rejects(
        cold.accounts.list(),
        /could not list GitHub accounts with gh/,
      );
      assert.deepEqual(cold.lookups, []);
    }
  } finally {
    console.warn = original;
  }
});

test("with no active account the first one is the default", async () => {
  const h = harness(() =>
    JSON.stringify([{ login: "solo", active: false, state: "success" }]),
  );
  assert.equal(await h.accounts.active(), "solo");
});

test("an avatar lookup that fails shows no avatar and is tried again later", async () => {
  let fail = true;
  const h = harness(undefined, async (token) => {
    if (fail) throw new Error("offline");
    return { login: "x", avatarUrl: `https://avatars.test/${token}` };
  });
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    assert.deepEqual(
      (await h.accounts.list()).map((a) => a.avatarUrl),
      [null, null, null],
    );
    assert.ok(
      warnings.some((w) => /could not look up a GitHub avatar/.test(w)),
    );
    fail = false;
    assert.equal(
      (await h.accounts.list())[0].avatarUrl,
      "https://avatars.test/tok-octo-work-1",
    );
  } finally {
    console.warn = original;
  }
});

test("without gh, or with no gh account, GITHUB_TOKEN's account stands in", async () => {
  const missing = Object.assign(new Error("spawn gh ENOENT"), {
    code: "ENOENT",
  });
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    for (const status of [
      () => {
        throw missing;
      },
      () => "[]",
    ]) {
      const h = harness(status);
      assert.deepEqual(await h.accounts.list(), [
        {
          login: "user-of-env-token",
          avatarUrl: "https://avatars.test/env-token",
          ok: true,
        },
      ]);
      assert.equal(await h.accounts.active(), "user-of-env-token");
      assert.equal(await h.accounts.isFallback(), true);
      assert.equal(await h.accounts.token("user-of-env-token"), "env-token");
      await assert.rejects(h.accounts.token("von"), UnknownAccountError);
      assert.deepEqual(h.lookups, ["env-token"]);
      assert.ok(h.calls.every((c) => c[2] === "status"));
    }
    assert.ok(warnings.some((w) => /using GITHUB_TOKEN's account/.test(w)));
  } finally {
    console.warn = original;
  }
});

test("without GITHUB_TOKEN, gh with no account fails with the fix, and a later login is picked up", async () => {
  let status = "[]";
  const accounts = ghAccounts({
    fallbackToken: undefined,
    exec: async (_, args) => (args[1] === "status" ? status : "tok-von\n"),
    lookupUser: async () => {
      throw new Error("lookupUser must not run without a token");
    },
  });
  await assert.rejects(
    accounts.list(),
    /gh has no github.com account and GITHUB_TOKEN is not set; run gh auth login/,
  );
  await assert.rejects(accounts.isFallback(), /GITHUB_TOKEN is not set/);
  status = JSON.stringify([{ login: "von", active: true, state: "success" }]);
  assert.equal(await accounts.active(), "von");
  assert.equal(await accounts.isFallback(), false);
  assert.equal(await accounts.token("von"), "tok-von");
});

test("the defaults build without running gh", () => {
  const accounts = ghAccounts({
    fallbackToken: "env-token",
    lookupUser: async () => ({ login: "x", avatarUrl: null }),
  });
  assert.equal(typeof accounts.list, "function");
});

test("a fallback account without an avatar lists a null avatar", async () => {
  const h = harness(
    () => "[]",
    async () => ({ login: "bot", avatarUrl: null }),
  );
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await h.accounts.list(), [
      { login: "bot", avatarUrl: null, ok: true },
    ]);
  } finally {
    console.warn = original;
  }
});

test("the default exec hides token variables so gh lists its own accounts", async () => {
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.GH_TOKEN = "a";
  process.env.GITHUB_TOKEN = "b";
  try {
    assert.equal(
      await defaultExecFile(process.execPath, [
        "-e",
        "process.stdout.write(String(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? 'none'))",
      ]),
      "none",
    );
    assert.equal(process.env.GITHUB_TOKEN, "b");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the default exec runs a program without a shell and rejects on failure", async () => {
  assert.equal(
    await defaultExecFile(process.execPath, [
      "-e",
      "process.stdout.write('ok $HOME')",
    ]),
    "ok $HOME",
  );
  await assert.rejects(
    defaultExecFile(process.execPath, ["-e", "process.exit(3)"]),
    /Command failed/,
  );
});
