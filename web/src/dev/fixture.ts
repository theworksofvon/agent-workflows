// Realistic data for the dev mock (MOCK_API=1). Not part of the app bundle:
// only vite.config.ts imports it, through mock-api.ts.
import { parsePatch } from "../lib/patch.ts";
import type {
  Account,
  ApiFinding,
  Check,
  CheckStatus,
  ChecksRollup,
  Guide,
  HumanState,
  InboxGroup,
  InboxPull,
  PullRequestFile,
  PullState,
  ReviewSession,
} from "../types.ts";

function added(source: string): string {
  const lines = source.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join(
    "\n",
  );
}

function file(path: string, status: string, patch: string): PullRequestFile {
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      if (line.kind === "del") deletions += 1;
    }
  }
  return { path, status, additions, deletions, patch };
}

const SETTLE_TS = `import type { Ledger } from "./ledger";
import type { MarketStore, PredictionStore } from "../db/stores";
import { payoutFor, type Outcome } from "./types";
import { logger } from "../logger";

export interface SettleDeps {
  markets: MarketStore;
  predictions: PredictionStore;
  ledger: Ledger;
  now: () => Date;
}

export interface SettleResult {
  marketId: string;
  settled: number;
  paidOut: bigint;
  skipped: number;
}

/**
 * Pay out every open prediction on a closed market. Safe to call more than
 * once: predictions that are already settled are skipped.
 */
export async function settleMarket(
  marketId: string,
  outcome: Outcome,
  deps: SettleDeps,
): Promise<SettleResult> {
  const market = await deps.markets.get(marketId);
  if (!market) throw new Error(\`unknown market \${marketId}\`);
  if (market.closesAt > deps.now()) {
    throw new Error(\`market \${marketId} is still open\`);
  }

  const open = await deps.predictions.listOpen(marketId);
  let paidOut = 0n;
  let skipped = 0;

  for (const prediction of open) {
    if (prediction.settledAt) {
      skipped += 1;
      continue;
    }
    const amount = payoutFor(prediction, outcome);
    if (amount > 0n) {
      await deps.ledger.post({
        account: prediction.accountId,
        amount,
        reason: \`settle:\${marketId}\`,
      });
      paidOut += amount;
    }
    await deps.predictions.markSettled(prediction.id, deps.now());
  }

  logger.info("market settled", { marketId, settled: open.length - skipped });
  await deps.markets.close(marketId, outcome);
  return { marketId, settled: open.length - skipped, paidOut, skipped };
}
`;

const LEDGER_TS = `import type { Database } from "../db/client";

export interface LedgerEntry {
  account: string;
  amount: bigint;
  reason: string;
}

export interface Ledger {
  post(entry: LedgerEntry): Promise<void>;
  balance(account: string): Promise<bigint>;
}

export function sqlLedger(db: Database): Ledger {
  return {
    async post(entry) {
      if (entry.amount === 0n) return;
      await db.query(
        "INSERT INTO ledger_entries (account_id, amount_cents, reason) VALUES ($1, $2, $3)",
        [entry.account, entry.amount.toString(), entry.reason],
      );
    },

    async balance(account) {
      const rows = await db.query<{ total: string | null }>(
        "SELECT SUM(amount_cents) AS total FROM ledger_entries WHERE account_id = $1",
        [account],
      );
      return BigInt(rows[0]?.total ?? "0");
    },
  };
}
`;

const TYPES_TS = `export type Outcome = "yes" | "no" | "void";

export interface Prediction {
  id: string;
  accountId: string;
  marketId: string;
  side: "yes" | "no";
  stakeCents: bigint;
  odds: number;
  settledAt: Date | null;
}

/** Cents owed to the account for this prediction once the market resolves. */
export function payoutFor(prediction: Prediction, outcome: Outcome): bigint {
  if (outcome === "void") return prediction.stakeCents;
  if (prediction.side !== outcome) return 0n;
  const winnings = Number(prediction.stakeCents) * prediction.odds;
  return BigInt(Math.round(winnings));
}
`;

const INDEX_TS = `export { settleMarket, type SettleDeps, type SettleResult } from "./settle";
export { sqlLedger, type Ledger, type LedgerEntry } from "./ledger";
export { payoutFor, type Outcome, type Prediction } from "./types";
`;

const ROUTE_TS = `import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth";
import { settleMarket, type SettleDeps } from "../../settlement";

const SettleBody = z.object({
  outcome: z.enum(["yes", "no", "void"]),
});

export function settlementRoutes(deps: SettleDeps): Router {
  const router = Router();

  router.post("/settlements/:marketId", requireUser, async (req, res) => {
    const body = SettleBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: body.error.flatten() });
    }
    const result = await settleMarket(
      req.params.marketId,
      body.data.outcome,
      deps,
    );
    return res.status(200).json({
      ...result,
      paidOut: result.paidOut.toString(),
    });
  });

  router.get("/settlements/:marketId", requireUser, async (req, res) => {
    const market = await deps.markets.get(req.params.marketId);
    if (!market) return res.status(404).json({ error: "not found" });
    return res.json({ marketId: market.id, outcome: market.outcome });
  });

  return router;
}
`;

const SERVER_PATCH = `@@ -1,9 +1,11 @@
 import express from "express";
 import { healthRoutes } from "./routes/health";
 import { marketRoutes } from "./routes/markets";
+import { settlementRoutes } from "./routes/settlement";
 import type { AppDeps } from "../deps";

 export function createServer(deps: AppDeps) {
   const app = express();
   app.use(express.json({ limit: "64kb" }));
+  app.disable("x-powered-by");

@@ -18,9 +20,10 @@ export function createServer(deps: AppDeps) {
   });

   app.use(healthRoutes());
   app.use(marketRoutes(deps.markets));
+  app.use(settlementRoutes(deps.settlement));

   return app;
 }`;

const AUTH_PATCH = `@@ -14,12 +14,22 @@ export interface AuthedRequest extends Request {
 export function requireUser(req: Request, res: Response, next: NextFunction) {
   const token = req.header("authorization")?.replace(/^Bearer /, "");
   if (!token) return res.status(401).json({ error: "missing token" });
-  const user = verifyToken(token);
-  if (!user) return res.status(401).json({ error: "invalid token" });
-  (req as AuthedRequest).user = user;
-  next();
+  try {
+    const user = verifyToken(token);
+    (req as AuthedRequest).user = user;
+    return next();
+  } catch {
+    return res.status(401).json({ error: "invalid token" });
+  }
+}
+
+export function requireAdmin(req: Request, res: Response, next: NextFunction) {
+  const user = (req as AuthedRequest).user;
+  if (!user?.roles.includes("admin")) {
+    return res.status(403).json({ error: "admin only" });
+  }
+  return next();
 }

 export function verifyToken(token: string): User {`;

const JOB_TS = `import type { SettleDeps } from "../settlement";
import { settleMarket } from "../settlement";
import type { OracleClient } from "../oracle/client";
import { logger } from "../logger";

export interface SettleMarketsJob {
  run(): Promise<void>;
}

/** Settle every market that closed and has an oracle outcome. */
export function settleMarketsJob(
  deps: SettleDeps & { oracle: OracleClient },
): SettleMarketsJob {
  return {
    async run() {
      const closed = await deps.markets.listClosedUnsettled(deps.now());
      for (const market of closed) {
        const outcome = await deps.oracle.outcomeFor(market.id);
        if (!outcome) continue;
        try {
          const result = await settleMarket(market.id, outcome, deps);
          console.log("settled", result);
        } catch (err) {
          logger.error("settlement failed", { marketId: market.id, err });
        }
      }
    },
  };
}
`;

const SCHEDULER_PATCH = `@@ -1,6 +1,7 @@
 import { CronJob } from "cron";
 import type { AppDeps } from "../deps";
 import { refreshOddsJob } from "./refresh-odds";
+import { settleMarketsJob } from "./settle-markets";

 export function startScheduler(deps: AppDeps): () => void {
   const jobs = [
@@ -9,6 +10,11 @@ export function startScheduler(deps: AppDeps): () => void {
       refreshOddsJob(deps.markets, deps.oracle).run(),
     ),
+    new CronJob("*/5 * * * *", () =>
+      settleMarketsJob({ ...deps.settlement, oracle: deps.oracle }).run(),
+    ),
   ];
   for (const job of jobs) job.start();
   return () => jobs.forEach((job) => job.stop());
 }`;

const CONFIG_PATCH = `@@ -8,10 +8,14 @@ const Env = z.object({
   DATABASE_URL: z.string().url(),
   PORT: z.coerce.number().int().default(8080),
   ORACLE_URL: z.string().url(),
+  SETTLEMENT_ENABLED: z
+    .enum(["true", "false"])
+    .default("false")
+    .transform((v) => v === "true"),
 });

 export type Config = z.infer<typeof Env>;

 export function loadConfig(env = process.env): Config {
   return Env.parse(env);
 }`;

const ENV_PATCH = `@@ -2,3 +2,5 @@ DATABASE_URL=postgres://localhost:5432/pluto
 PORT=8080
 ORACLE_URL=http://localhost:9000
+# Turn on the scheduled settlement job (pays out closed markets).
+SETTLEMENT_ENABLED=false`;

const PACKAGE_PATCH = `@@ -14,6 +14,7 @@
   "dependencies": {
     "cron": "^3.1.7",
     "express": "^4.19.2",
+    "pg": "^8.12.0",
     "zod": "^3.23.8"
   },
   "devDependencies": {`;

const MIGRATION_SQL = `-- Double-entry style ledger for prediction payouts.
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  account_id    TEXT        NOT NULL REFERENCES accounts(id),
  amount_cents  BIGINT      NOT NULL,
  reason        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE predictions ADD COLUMN settled_at TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN outcome TEXT
  CHECK (outcome IN ('yes', 'no', 'void'));
`;

const SCHEMA_PATCH = `@@ -21,6 +21,7 @@ export interface PredictionRow {
   side: "yes" | "no";
   stake_cents: string;
   odds: number;
+  settled_at: Date | null;
 }

 export interface MarketRow {
@@ -28,4 +29,12 @@ export interface MarketRow {
   title: string;
   closes_at: Date;
+  outcome: "yes" | "no" | "void" | null;
+}
+
+export interface LedgerEntryRow {
+  id: string;
+  account_id: string;
+  amount_cents: string;
+  reason: string;
 }`;

const SETTLE_TEST = `import { describe, expect, it } from "vitest";
import { settleMarket } from "../../src/settlement";
import { fakeDeps, prediction } from "./fakes";

describe("settleMarket", () => {
  it("pays winners and marks every prediction settled", async () => {
    const deps = fakeDeps({
      predictions: [
        prediction({ id: "p1", side: "yes", stakeCents: 1000n, odds: 1.5 }),
        prediction({ id: "p2", side: "no", stakeCents: 500n, odds: 2 }),
      ],
    });

    const result = await settleMarket("m1", "yes", deps);

    expect(result.paidOut).toBe(1500n);
    expect(deps.ledger.entries).toEqual([
      { account: "acct-p1", amount: 1500n, reason: "settle:m1" },
    ]);
    expect(deps.settled()).toEqual(["p1", "p2"]);
  });

  it("refunds every stake when the market is void", async () => {
    const deps = fakeDeps({
      predictions: [prediction({ id: "p1", stakeCents: 700n })],
    });

    const result = await settleMarket("m1", "void", deps);

    expect(result.paidOut).toBe(700n);
  });

  it("refuses to settle a market that is still open", async () => {
    const deps = fakeDeps({ closesAt: new Date("2999-01-01") });

    await expect(settleMarket("m1", "yes", deps)).rejects.toThrow(
      "market m1 is still open",
    );
  });

  it("skips predictions that are already settled", async () => {
    const deps = fakeDeps({
      predictions: [prediction({ id: "p1", settledAt: new Date() })],
    });

    const result = await settleMarket("m1", "yes", deps);

    expect(result.skipped).toBe(1);
    expect(deps.ledger.entries).toEqual([]);
  });
});
`;

const LEDGER_TEST = `import { describe, expect, it } from "vitest";
import { sqlLedger } from "../../src/settlement";
import { testDatabase } from "../db";

describe("sqlLedger", () => {
  it("sums posted entries into a balance", async () => {
    const db = await testDatabase();
    const ledger = sqlLedger(db);

    await ledger.post({ account: "a1", amount: 250n, reason: "test" });
    await ledger.post({ account: "a1", amount: -50n, reason: "test" });

    expect(await ledger.balance("a1")).toBe(200n);
  });

  it("does not write zero-amount entries", async () => {
    const db = await testDatabase();
    const ledger = sqlLedger(db);

    await ledger.post({ account: "a1", amount: 0n, reason: "noop" });

    expect(await db.query("SELECT * FROM ledger_entries")).toEqual([]);
  });
});
`;

const ROUTE_TEST = `import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestApp, tokenFor } from "../app";

describe("POST /settlements/:marketId", () => {
  it("settles a closed market", async () => {
    const app = await createTestApp();

    const res = await request(app)
      .post("/settlements/m1")
      .set("authorization", \`Bearer \${tokenFor("admin")}\`)
      .send({ outcome: "yes" });

    expect(res.status).toBe(200);
    expect(res.body.marketId).toBe("m1");
  });

  it("rejects an unknown outcome", async () => {
    const app = await createTestApp();

    const res = await request(app)
      .post("/settlements/m1")
      .set("authorization", \`Bearer \${tokenFor("admin")}\`)
      .send({ outcome: "maybe" });

    expect(res.status).toBe(400);
  });
});
`;

const FAKES_PATCH = `@@ -1,5 +1,5 @@
-import type { SettleDeps } from "../../src/settlement/settle";
+import type { SettleDeps } from "../../src/settlement";
 import type { Prediction } from "../../src/settlement/types";

 export function prediction(over: Partial<Prediction> = {}): Prediction {
   return {
@@ -30,8 +30,9 @@ export function fakeDeps(opts: FakeOptions = {}) {
     ledger,
     now: () => new Date("2026-10-01T00:00:00Z"),
-    settled: () => settled,
+    settled: () => [...settled],
+    closesAt: opts.closesAt ?? new Date("2026-09-30T00:00:00Z"),
   };
 }`;

const DOC_MD = `# Settlement

When a market closes, the oracle publishes an outcome: \`yes\`, \`no\`, or
\`void\`. Settlement turns that outcome into ledger entries.

## How it runs

1. The scheduler runs \`settleMarketsJob\` every 5 minutes.
2. The job lists closed markets without an outcome and asks the oracle.
3. \`settleMarket\` pays each winning prediction and marks it settled.
4. Admins can force a settlement with \`POST /settlements/:marketId\`.

## Money

All amounts are integer cents (\`bigint\`). The ledger never stores floats.

## Turning it on

Set \`SETTLEMENT_ENABLED=true\`. It is off by default in every environment.
`;

const README_PATCH = `@@ -31,6 +31,8 @@ pnpm dev
 - \`src/api\` — HTTP routes
 - \`src/jobs\` — scheduled jobs
 - \`src/oracle\` — outcome feed client
+- \`src/settlement\` — pays out closed markets through the ledger
+  (see [docs/settlement.md](docs/settlement.md))

 ## Deploying
 `;

function lockfilePatch(): string {
  const lines: string[] = ["@@ -1180,6 +1180,452 @@ packages:"];
  lines.push(
    "   /path-to-regexp@0.1.10:",
    "     resolution: {integrity: sha512-7lf7qcQidTku0Gu3YDPc8DJ1q7OOucfa/BSsIwjuh56VU7katFvuM8hULfkwB3Fns/rsVF7PwPKVw1sl5KQS9w==}",
    "     dev: false",
  );
  const pkgs = [
    "pg",
    "pg-cloudflare",
    "pg-connection-string",
    "pg-int8",
    "pg-pool",
    "pg-protocol",
    "pg-types",
    "pgpass",
    "postgres-array",
    "postgres-bytea",
    "postgres-date",
    "postgres-interval",
    "split2",
    "xtend",
  ];
  let n = 0;
  while (lines.length < 450) {
    const name = pkgs[n % pkgs.length]!;
    const major = 1 + (n % 7);
    lines.push(
      "+",
      `+  /${name}@${major}.${n % 10}.${(n * 3) % 13}:`,
      `+    resolution: {integrity: sha512-${(n * 7919).toString(36).padEnd(12, "q")}${"Xk9Lm2Pq".repeat(6)}==}`,
      "+    engines: {node: '>=4.0.0'}",
      "+    dev: false",
    );
    n += 1;
  }
  return lines.join("\n");
}

const FILES: PullRequestFile[] = [
  file("src/settlement/settle.ts", "added", added(SETTLE_TS)),
  file("src/settlement/ledger.ts", "added", added(LEDGER_TS)),
  file("src/settlement/types.ts", "added", added(TYPES_TS)),
  file("src/settlement/index.ts", "added", added(INDEX_TS)),
  file("src/api/routes/settlement.ts", "added", added(ROUTE_TS)),
  file("src/api/server.ts", "modified", SERVER_PATCH),
  file("src/api/auth.ts", "modified", AUTH_PATCH),
  file("src/jobs/settle-markets.ts", "added", added(JOB_TS)),
  file("src/jobs/scheduler.ts", "modified", SCHEDULER_PATCH),
  file("src/config.ts", "modified", CONFIG_PATCH),
  file(".env.example", "modified", ENV_PATCH),
  file("package.json", "modified", PACKAGE_PATCH),
  file("migrations/0007_ledger.sql", "added", added(MIGRATION_SQL)),
  file("src/db/schema.ts", "modified", SCHEMA_PATCH),
  file("tests/settlement/settle.test.ts", "added", added(SETTLE_TEST)),
  file("tests/settlement/ledger.test.ts", "added", added(LEDGER_TEST)),
  file("tests/api/settlement-route.test.ts", "added", added(ROUTE_TEST)),
  file("tests/settlement/fakes.ts", "modified", FAKES_PATCH),
  file("docs/settlement.md", "added", added(DOC_MD)),
  file("README.md", "modified", README_PATCH),
  file("pnpm-lock.yaml", "modified", lockfilePatch()),
];

/** New-side line number of the first line in `path` that contains `snippet`. */
function lineOf(path: string, snippet: string): number {
  const f = FILES.find((x) => x.path === path);
  for (const hunk of parsePatch(f?.patch ?? null)) {
    for (const line of hunk.lines) {
      if (line.newLine !== null && line.text.includes(snippet)) {
        return line.newLine;
      }
    }
  }
  throw new Error(`fixture: "${snippet}" not found in ${path}`);
}

const GUIDE: Guide = {
  overview: {
    context:
      "This PR adds settlement: when a prediction market closes, a scheduled job asks the oracle for the outcome, pays every winning prediction through a new `ledger_entries` table, and marks the predictions settled. Admins can also force a settlement over the API. The job is off by default behind `SETTLEMENT_ENABLED`.",
    steps: [
      "Add `settleMarket`, which pays winners through a `Ledger` and marks each prediction settled.",
      "Store payouts as integer cents in a new `ledger_entries` table.",
      "Run `settleMarketsJob` every 5 minutes for closed markets with an oracle outcome.",
      "Expose `POST /settlements/:marketId` so an admin can settle by hand.",
      "Gate the job behind `SETTLEMENT_ENABLED` (default `false`).",
    ],
    flows: [
      {
        title: "Closed market to payout",
        caption: "A closed market now becomes ledger entries",
        before: [
          { label: "CronJob", change: "unchanged", chapter: null },
          { label: "refreshOddsJob", change: "unchanged", chapter: null },
          { label: "markets.close()", change: "unchanged", chapter: null },
        ],
        after: [
          { label: "CronJob", change: "unchanged", chapter: null },
          { label: "settleMarketsJob", change: "added", chapter: "schedule" },
          { label: "oracle.outcomeFor()", change: "unchanged", chapter: null },
          { label: "settleMarket()", change: "added", chapter: "settle-core" },
          { label: "ledger.post()", change: "added", chapter: "settle-core" },
          { label: "ledger_entries", change: "added", chapter: "ledger-data" },
          {
            label: "markets.close()",
            change: "changed",
            chapter: "settle-core",
          },
        ],
      },
      {
        title: "Authenticated request",
        caption: "Token errors no longer crash the request",
        before: [
          { label: "Bearer token", change: "unchanged", chapter: null },
          {
            label: "verifyToken() → null",
            change: "removed",
            chapter: "api-jobs",
          },
          { label: "route handler", change: "unchanged", chapter: null },
        ],
        after: [
          { label: "Bearer token", change: "unchanged", chapter: null },
          {
            label: "verifyToken() throws",
            change: "changed",
            chapter: "api-jobs",
          },
          { label: "requireAdmin", change: "added", chapter: "api-jobs" },
          { label: "settlementRoutes", change: "added", chapter: "api-jobs" },
        ],
      },
    ],
  },
  chapters: [
    {
      id: "settle-core",
      title: "Pay out a closed market through the ledger",
      role: "core",
      summary:
        "`settleMarket` is the heart of the change. It loads the market, refuses to run while the market is open, and walks every open prediction: winners get a ledger entry, and every prediction is marked settled.\n\nThe `Ledger` port keeps SQL out of the settlement logic. Amounts are `bigint` cents end to end, except inside `payoutFor`, which multiplies by the odds.",
      files: [
        "src/settlement/settle.ts",
        "src/settlement/ledger.ts",
        "src/settlement/types.ts",
        "src/settlement/index.ts",
      ],
    },
    {
      id: "api-jobs",
      title: "Run settlement on a schedule and over the API",
      role: "supporting",
      summary:
        "A new cron entry runs `settleMarketsJob` every 5 minutes. The job settles each closed market that has an oracle outcome and logs failures per market, so one bad market does not stop the rest.\n\n`POST /settlements/:marketId` lets an operator force a settlement. `requireUser` now catches token errors, and a new `requireAdmin` middleware exists.",
      files: [
        "src/jobs/settle-markets.ts",
        "src/jobs/scheduler.ts",
        "src/api/routes/settlement.ts",
        "src/api/server.ts",
        "src/api/auth.ts",
      ],
    },
    {
      id: "config",
      title: "Feature flag and dependencies",
      role: "config",
      summary:
        "`SETTLEMENT_ENABLED` defaults to `false`. `pg` becomes a direct dependency because the ledger talks to Postgres.",
      files: ["src/config.ts", ".env.example", "package.json"],
    },
    {
      id: "ledger-data",
      title: "Ledger table and settled columns",
      role: "data",
      summary:
        "The migration adds `ledger_entries` and two nullable columns: `predictions.settled_at` and `markets.outcome`. Row types follow.",
      files: ["migrations/0007_ledger.sql", "src/db/schema.ts"],
    },
    {
      id: "tests",
      title: "Settlement and route tests",
      role: "tests",
      summary:
        "Unit tests cover winners, void refunds, open markets, and re-runs. The route test checks the happy path and a bad outcome.",
      files: [
        "tests/settlement/settle.test.ts",
        "tests/settlement/ledger.test.ts",
        "tests/api/settlement-route.test.ts",
        "tests/settlement/fakes.ts",
      ],
    },
    {
      id: "other",
      title: "Other changes",
      role: "supporting",
      summary: "Files the guide did not place in a chapter.",
      files: ["docs/settlement.md", "README.md", "pnpm-lock.yaml"],
    },
  ],
};

export const FINDINGS: ApiFinding[] = [
  {
    id: "a3f9c2e17b04",
    path: "src/settlement/settle.ts",
    line: lineOf(
      "src/settlement/settle.ts",
      "await deps.predictions.markSettled",
    ),
    severity: "high",
    body: "Settlement is not idempotent across a crash. If the process dies after `ledger.post` but before `markSettled`, the next run pays the same prediction again.\n\nWrap the ledger write and `markSettled` in one transaction, or key ledger entries by `prediction.id` with a unique index.",
  },
  {
    id: "5d1e88b2c9aa",
    path: "src/api/routes/settlement.ts",
    line: lineOf("src/api/routes/settlement.ts", "router.post("),
    severity: "critical",
    body: "`POST /settlements/:marketId` only uses `requireUser`. Any signed-in user can settle any market with any outcome. `requireAdmin` exists in this PR but is never applied.",
  },
  {
    id: "0c7be41f6d23",
    path: "src/settlement/types.ts",
    line: lineOf("src/settlement/types.ts", "Number(prediction.stakeCents)"),
    severity: "medium",
    body: "`Number(stakeCents) * odds` goes through floating point. Stakes above 2^53 cents lose precision, and `Math.round` hides the error. Store odds as basis points and stay in `bigint`.",
  },
  {
    id: "e92a07d3b815",
    path: "src/jobs/settle-markets.ts",
    line: lineOf("src/jobs/settle-markets.ts", "console.log("),
    severity: "low",
    body: "Use `logger.info` here instead of `console.log` so the line reaches the structured log pipeline.",
  },
  {
    id: "7b40fd19e6c2",
    path: "migrations/0007_ledger.sql",
    line: lineOf("migrations/0007_ledger.sql", "account_id    TEXT"),
    severity: "medium",
    body: "`balance()` filters by `account_id`, but there is no index on it. Add `CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);`.",
  },
  {
    id: "c18d5a63f0be",
    path: "src/api/server.ts",
    line: 16,
    severity: "medium",
    body: "The error handler above the new route still returns `err.message` to the client. Settlement errors include market ids and account ids, so this now leaks internal identifiers.",
  },
];

const PR = {
  title: "Settle closed prediction markets through a ledger",
  body: "Adds scheduled settlement, a ledger table, and an admin route.\n\nCloses #11.",
  author: "ekjackson",
  authorAvatarUrl: avatar("ekjackson"),
  state: "open" as PullState,
  lastCommit: {
    authorLogin: "ekjackson",
    authorName: "EK Jackson",
    committedAt: iso(47),
  },
  url: "https://github.com/acme-labs/pluto-predicts/pull/14",
  headRef: "feat/settlement-ledger",
  baseRef: "main",
  headSha: "9fc3023b1e7d4a0c55e2f1b8a6d93c07e4f12ab9",
  files: FILES,
};

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export interface FixtureSession {
  session: ReviewSession;
  human: HumanState;
  findings: ApiFinding[];
}

export function buildFixture(): FixtureSession[] {
  const ready: FixtureSession = {
    session: {
      id: "demo-settlement",
      repo: { owner: "acme-labs", repo: "pluto-predicts" },
      prNumber: 14,
      status: "ready",
      stage: "ready",
      error: null,
      createdAt: iso(42),
      updatedAt: iso(31),
      agent: "claude",
      account: "octocat",
      pr: PR,
      triage: {
        depth: "deep",
        needsGuide: true,
        risk: 3,
        engine: "heuristic",
        confidence: 0.82,
        reasons: ["sensitive-path", "many-files:21"],
        probabilities: null,
      },
      guide: { value: GUIDE, error: null },
      review: {
        value: {
          summary:
            "Settlement logic is clear and well tested, but the admin route is open to every user and a crash between the ledger write and `markSettled` double-pays.",
          findings: FINDINGS.map(({ id: _id, ...f }) => f),
        },
        error: null,
        adversarial: true,
      },
      publishedAt: null,
    },
    human: {
      chapters: { "settle-core": true },
      files: {
        "src/settlement/settle.ts": true,
        "src/settlement/ledger.ts": true,
        "src/settlement/index.ts": true,
      },
      verdicts: {
        "5d1e88b2c9aa": {
          verdict: "agree",
          note: "Confirmed: requireAdmin is defined in auth.ts but never wired up.",
          updatedAt: iso(20),
        },
        e92a07d3b815: {
          verdict: "disagree",
          note: "",
          updatedAt: iso(18),
        },
        "0c7be41f6d23": { verdict: "unsure", note: "", updatedAt: iso(17) },
      },
      comments: [
        {
          id: "hc-1",
          path: "src/settlement/settle.ts",
          line: lineOf(
            "src/settlement/settle.ts",
            "if (market.closesAt > deps.now())",
          ),
          body: "Should this compare against the oracle's resolution time instead of `closesAt`? Markets can close early.",
          createdAt: iso(25),
        },
        {
          id: "hc-2",
          path: "migrations/0007_ledger.sql",
          line: lineOf("migrations/0007_ledger.sql", "ALTER TABLE markets"),
          body: "Nit: name the CHECK constraint so the next migration can drop it.",
          createdAt: iso(22),
        },
      ],
    },
    findings: FINDINGS,
  };

  const small = FILES.filter((f) =>
    ["src/config.ts", ".env.example"].includes(f.path),
  );
  const diffOnly: FixtureSession = {
    session: {
      ...ready.session,
      id: "demo-diff-only",
      repo: { owner: "acme-labs", repo: "infra" },
      prNumber: 2,
      createdAt: iso(180),
      updatedAt: iso(170),
      pr: {
        ...PR,
        title: "Add a feature flag for nightly backups",
        author: "octocat",
        authorAvatarUrl: avatar("octocat"),
        url: "https://github.com/acme-labs/infra/pull/2",
        headRef: "chore/backup-flag",
        files: small,
      },
      triage: {
        depth: "light",
        needsGuide: false,
        risk: 1,
        engine: "heuristic",
        confidence: null,
        reasons: [],
        probabilities: null,
      },
      guide: {
        value: null,
        error: "guide agent exited with code 1: rate limited",
      },
      review: {
        value: { summary: "Small config change; no issues.", findings: [] },
        error: null,
        adversarial: false,
      },
      publishedAt: iso(160),
    },
    human: { chapters: {}, files: {}, verdicts: {}, comments: [] },
    findings: [],
  };

  const running: FixtureSession = {
    session: {
      ...ready.session,
      id: "demo-running",
      prNumber: 12,
      status: "analyzing",
      stage: "Writing the guide and reviewing 21 files",
      createdAt: iso(2),
      updatedAt: iso(0.2),
      pr: {
        ...PR,
        title: "Stream odds updates over SSE",
        url: "https://github.com/acme-labs/pluto-predicts/pull/12",
        headRef: "feat/sse-odds",
        lastCommit: {
          authorLogin: "mayaokafor",
          authorName: "Maya Okafor",
          committedAt: iso(4),
        },
      },
      triage: {
        depth: "standard",
        needsGuide: true,
        risk: 2,
        engine: "heuristic",
        confidence: 0.67,
        reasons: [],
        probabilities: null,
      },
      guide: { value: null, error: null },
      review: { value: null, error: null, adversarial: false },
    },
    human: { chapters: {}, files: {}, verdicts: {}, comments: [] },
    findings: [],
  };

  const failed: FixtureSession = {
    session: {
      ...running.session,
      id: "demo-failed",
      prNumber: 8,
      status: "failed",
      stage: "preparing",
      error:
        "git worktree add failed: fatal: invalid reference: feat/old-branch",
      createdAt: iso(60 * 26),
      updatedAt: iso(60 * 26),
      pr: {
        ...PR,
        title: "Backfill historical odds",
        url: "https://github.com/acme-labs/pluto-predicts/pull/8",
        headRef: "feat/old-branch",
      },
      triage: null,
    },
    human: { chapters: {}, files: {}, verdicts: {}, comments: [] },
    findings: [],
  };

  // The first run of #14, before the re-run that `ready` stands for.
  const firstRun: FixtureSession = {
    session: {
      ...structuredClone(ready.session),
      id: "demo-settlement-r1",
      createdAt: iso(60 * 6),
      updatedAt: iso(60 * 5.5),
      publishedAt: null,
    },
    human: {
      chapters: {},
      files: { "src/settlement/settle.ts": true },
      verdicts: {},
      comments: [],
    },
    findings: FINDINGS.slice(0, 4),
  };

  return [running, ready, diffOnly, failed, firstRun];
}

// ── GitHub: accounts, inbox pulls, and CI checks ──────────

export const ACCOUNTS: Account[] = [
  { login: "octocat", avatarUrl: avatar("octocat") },
  { login: "octo-work", avatarUrl: avatar("octo-work") },
];

export function avatar(login: string): string {
  return `https://github.com/${login}.png?size=80`;
}


interface PullSeed {
  repo: string;
  number: number;
  title: string;
  author: string;
  state?: PullState;
  checks: ChecksRollup;
  groups: InboxGroup[];
  updated: number;
  pushed?: { by: string; ago: number };
  head: string;
  stats?: [number, number, number];
  decision?: InboxPull["reviewDecision"];
}

function pull(seed: PullSeed): InboxPull {
  const [owner, repo] = seed.repo.split("/") as [string, string];
  const pushedBy = seed.pushed?.by ?? seed.author;
  return {
    repo: { owner, repo },
    number: seed.number,
    title: seed.title,
    url: `https://github.com/${seed.repo}/pull/${seed.number}`,
    author: { login: seed.author, avatarUrl: avatar(seed.author) },
    headRef: seed.head,
    baseRef: "main",
    state: seed.state ?? "open",
    reviewDecision: seed.decision ?? "review_required",
    updatedAt: iso(seed.updated),
    lastCommit: {
      authorLogin: pushedBy,
      authorName: pushedBy,
      committedAt: iso(seed.pushed?.ago ?? seed.updated + 4),
    },
    checks: seed.checks,
    additions: seed.stats?.[0] ?? null,
    deletions: seed.stats?.[1] ?? null,
    changedFiles: seed.stats?.[2] ?? null,
    groups: seed.groups,
    sessionId: null,
  };
}

const PLUTO = "acme-labs/pluto-predicts";
const INFRA = "acme-labs/infra";
const AW = "octocat/agent-workflows";
const DOTFILES = "octocat/dotfiles";

/** Inbox pulls per account login. */
export function buildInbox(): Record<string, InboxPull[]> {
  return {
    octocat: [
      pull({
        repo: PLUTO,
        number: 14,
        title: "Settle closed prediction markets through a ledger",
        author: "ekjackson",
        checks: "failing",
        groups: ["reviewRequested"],
        updated: 31,
        pushed: { by: "ekjackson", ago: 47 },
        head: "feat/settlement-ledger",
        stats: [1243, 18, 21],
      }),
      pull({
        repo: PLUTO,
        number: 12,
        title: "Stream odds updates over SSE",
        author: "ekjackson",
        checks: "pending",
        groups: ["reviewRequested"],
        updated: 3,
        pushed: { by: "mayaokafor", ago: 4 },
        head: "feat/sse-odds",
        stats: [412, 96, 9],
      }),
      pull({
        repo: PLUTO,
        number: 17,
        title: "Rate-limit the public odds API per API key",
        author: "mayaokafor",
        checks: "passing",
        groups: ["reviewRequested"],
        updated: 95,
        head: "feat/rate-limit",
        stats: [188, 22, 6],
      }),
      pull({
        repo: INFRA,
        number: 5,
        title: "Move Grafana behind the VPN",
        author: "ekjackson",
        state: "draft",
        checks: null,
        groups: ["reviewRequested"],
        updated: 60 * 5,
        head: "chore/grafana-vpn",
        stats: [64, 31, 4],
      }),
      pull({
        repo: AW,
        number: 41,
        title: "Retry GitHub GraphQL calls on secondary rate limits",
        author: "kiraboone",
        checks: "failing",
        groups: ["reviewRequested"],
        updated: 60 * 26,
        head: "fix/graphql-retry",
        stats: [97, 12, 3],
        decision: "changes_requested",
      }),
      pull({
        repo: AW,
        number: 42,
        title: "Guided review: GitHub inbox, accounts, and CI checks",
        author: "octocat",
        state: "draft",
        checks: "pending",
        groups: ["authored"],
        updated: 12,
        head: "feat/guided-review",
        stats: [2140, 310, 38],
        decision: null,
      }),
      pull({
        repo: DOTFILES,
        number: 19,
        title: "Pin mise tools and drop duplicate brew formulae",
        author: "octocat",
        checks: "passing",
        groups: ["authored"],
        updated: 60 * 3,
        head: "chore/toolchain-dedupe",
        stats: [41, 58, 3],
        decision: "approved",
      }),
      pull({
        repo: INFRA,
        number: 2,
        title: "Add a feature flag for nightly backups",
        author: "octocat",
        checks: "passing",
        groups: ["authored"],
        updated: 170,
        head: "chore/backup-flag",
        stats: [6, 1, 2],
      }),
      pull({
        repo: AW,
        number: 39,
        title: "Queue guided runs behind MAX_CONCURRENT_RUNS",
        author: "octocat",
        state: "merged",
        checks: "passing",
        groups: ["authored"],
        updated: 60 * 30,
        head: "fix/run-queue",
        stats: [220, 40, 7],
        decision: "approved",
      }),
      pull({
        repo: PLUTO,
        number: 8,
        title: "Backfill historical odds",
        author: "ekjackson",
        checks: null,
        groups: ["involved"],
        updated: 60 * 26,
        head: "feat/old-branch",
        stats: [530, 4, 11],
      }),
      pull({
        repo: INFRA,
        number: 4,
        title: "Upgrade k3s to v1.31 and pin the CNI",
        author: "ekjackson",
        checks: "failing",
        groups: ["involved"],
        updated: 60 * 8,
        pushed: { by: "renovate[bot]", ago: 60 * 9 },
        head: "renovate/k3s-1.x",
        stats: [18, 18, 2],
      }),
      pull({
        repo: PLUTO,
        number: 11,
        title: "Settlement design doc",
        author: "mayaokafor",
        state: "merged",
        checks: "passing",
        groups: ["involved"],
        updated: 60 * 50,
        head: "docs/settlement",
        stats: [140, 0, 1],
        decision: "approved",
      }),
    ],
    "octo-work": [
      pull({
        repo: "acme/billing",
        number: 212,
        title: "Port cost curves to the 2027 rate tables",
        author: "mlindqvist",
        checks: "failing",
        groups: ["reviewRequested"],
        updated: 22,
        head: "feat/rate-tables-2027",
        stats: [860, 402, 17],
      }),
      pull({
        repo: "acme/pricing",
        number: 77,
        title: "Drop the legacy PDF exporter",
        author: "akumar",
        checks: "pending",
        groups: ["reviewRequested"],
        updated: 50,
        head: "chore/drop-pdf",
        stats: [12, 940, 23],
      }),
      pull({
        repo: "acme/billing",
        number: 208,
        title: "Cache supplier quotes per region",
        author: "octo-work",
        checks: "passing",
        groups: ["authored"],
        updated: 60 * 4,
        head: "feat/quote-cache",
        stats: [233, 41, 8],
      }),
      pull({
        repo: "acme/pricing",
        number: 74,
        title: "Bump pnpm to 11",
        author: "renovate[bot]",
        checks: "passing",
        groups: ["involved"],
        updated: 60 * 20,
        head: "renovate/pnpm-11",
        stats: [3, 3, 2],
      }),
    ],
  };
}

function check(
  name: string,
  status: CheckStatus,
  workflowName: string | null,
  startedMinutesAgo: number,
): Check {
  const done = status !== "pending";
  return {
    name,
    workflowName,
    status,
    url: `https://github.com/acme-labs/pluto-predicts/actions/runs/${1000 + startedMinutesAgo}`,
    startedAt: iso(startedMinutesAgo),
    completedAt: done ? iso(startedMinutesAgo - 2) : null,
  };
}

/** Check lists for the pulls that have a guided review. */
export function checksFor(
  key: string,
  rollup: ChecksRollup,
  startedAt: number,
): Check[] {
  const settled = Date.now() - startedAt > 600_000;
  switch (key) {
    case "acme-labs/pluto-predicts#14":
      return [
        check("lint", "success", "CI", 46),
        check("typecheck", "success", "CI", 46),
        // An earlier run of the same job: the newest one below wins.
        check("test (unit)", "success", "CI", 120),
        check("test (unit)", "failure", "CI", 46),
        check("test (integration)", "success", "CI", 46),
        check("build", "success", "CI", 46),
        check("build", "success", "Release", 45),
        check("Analyze (javascript)", "success", "CodeQL", 45),
        check("Vercel – pluto-web", "success", null, 44),
        check("deploy-preview", "skipped", "Preview", 44),
      ];
    case "acme-labs/pluto-predicts#12":
      return [
        check("lint", "success", "CI", 4),
        check("typecheck", "success", "CI", 4),
        check("test (unit)", settled ? "success" : "pending", "CI", 4),
        check("build", settled ? "success" : "pending", "CI", 4),
        check("Vercel – pluto-web", settled ? "success" : "pending", null, 3),
      ];
    default:
      if (rollup === null) return [];
      return [
        check("lint", "success", "CI", 30),
        check(
          "test",
          rollup === "failing"
            ? "failure"
            : rollup === "pending"
              ? "pending"
              : "success",
          "CI",
          30,
        ),
        check("build", rollup === "pending" ? "pending" : "success", "CI", 30),
      ];
  }
}
