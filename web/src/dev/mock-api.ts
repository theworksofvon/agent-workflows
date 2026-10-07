// In-memory stand-in for the review server, used by `MOCK_API=1 vite`.
// It follows the HTTP contract of Task 6 closely enough to drive every
// screen; publish composition is a simplified copy of Task 5's rules.
import type { IncomingMessage, ServerResponse } from "node:http";
import { newSideLines, parsePatch } from "../lib/patch.ts";
import type {
  ComposedReview,
  InboxPull,
  ReviewEvent,
  SessionStatus,
  SessionSummary,
} from "../types.ts";
import { checksRollup, dedupeChecks } from "../lib/checks.ts";
import {
  ACCOUNTS,
  buildFixture,
  buildInbox,
  checksFor,
  type FixtureSession,
} from "./fixture.ts";

type Next = (err?: unknown) => void;

const RUN_STAGES: { status: SessionStatus; stage: string }[] = [
  { status: "queued", stage: "Waiting for a free agent slot" },
  { status: "triaging", stage: "Checking how deep to review" },
  { status: "preparing", stage: "Checking out feat/settlement-ledger" },
  { status: "analyzing", stage: "Writing the guide and reviewing 21 files" },
];

export function mockApi() {
  const sessions = new Map<string, FixtureSession>();
  for (const s of buildFixture()) sessions.set(s.session.id, s);
  const ready = sessions.get("demo-settlement")!;
  const runStarts = new Map<string, number>([["demo-running", Date.now()]]);
  const mockStart = Date.now();
  const inbox = buildInbox();
  let current = ACCOUNTS[0]!.login;

  const keyOf = (owner: string, repo: string, n: number) =>
    `${owner}/${repo}#${n}`.toLowerCase();
  const allPulls = () => Object.values(inbox).flat();
  const findPull = (owner: string, repo: string, n: number) =>
    allPulls().find(
      (p) => keyOf(p.repo.owner, p.repo.repo, p.number) === keyOf(owner, repo, n),
    );

  /** The latest session of a pull request, like the server's `sessionId`. */
  function latestSession(p: InboxPull): string | null {
    let best: FixtureSession | null = null;
    for (const e of sessions.values()) {
      const s = e.session;
      if (keyOf(s.repo.owner, s.repo.repo, s.prNumber) !== keyOf(p.repo.owner, p.repo.repo, p.number))
        continue;
      if (!best || s.updatedAt > best.session.updatedAt) best = e;
    }
    return best?.session.id ?? null;
  }

  // A started run walks through the stages, then copies the ready session.
  function advance(entry: FixtureSession): void {
    const started = runStarts.get(entry.session.id);
    if (started === undefined) return;
    const step = Math.floor((Date.now() - started) / 3000);
    if (step < RUN_STAGES.length) {
      Object.assign(entry.session, RUN_STAGES[step], {
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    runStarts.delete(entry.session.id);
    Object.assign(entry.session, {
      status: "ready",
      stage: "ready",
      guide: ready.session.guide,
      review: ready.session.review,
      triage: ready.session.triage,
      pr: {
        ...ready.session.pr!,
        ...entry.session.pr,
        files: ready.session.pr!.files,
      },
      updatedAt: new Date().toISOString(),
    });
    entry.findings = ready.findings;
  }

  function startRun(
    from: FixtureSession,
    pull?: InboxPull,
    account = from.session.account,
  ): string {
    const id = `run-${Date.now().toString(36)}`;
    const base = structuredClone(from.session);
    if (pull) {
      base.repo = { ...pull.repo };
      base.prNumber = pull.number;
      base.pr = {
        ...base.pr!,
        title: pull.title,
        author: pull.author.login,
        authorAvatarUrl: pull.author.avatarUrl,
        url: pull.url,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        state: pull.state,
        lastCommit: pull.lastCommit,
      };
    }
    sessions.set(id, {
      session: {
        ...base,
        account,
        id,
        status: "queued",
        stage: RUN_STAGES[0]!.stage,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        guide: { value: null, error: null },
        review: { value: null, error: null, adversarial: false },
        publishedAt: null,
      },
      human: { chapters: {}, files: {}, verdicts: {}, comments: [] },
      findings: [],
    });
    runStarts.set(id, Date.now());
    return id;
  }

  return async function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Next,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    if (!url.pathname.startsWith("/api/")) return next();
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const body = method === "GET" ? {} : await readJson(req);
    await new Promise((r) => setTimeout(r, 120));

    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
    };

    if (parts[0] === "health") {
      return send(200, {
        ok: true,
        agent: "claude",
      });
    }

    if (parts[0] === "accounts") {
      if (parts[1] === "current" && method === "PUT") {
        const login = String(body.login ?? "");
        if (!ACCOUNTS.some((a) => a.login === login))
          return send(400, { error: `unknown account: ${login}` });
        current = login;
        return send(200, { current });
      }
      // The second account has a rejected token, to show the warning badge.
      return send(200, {
        accounts: ACCOUNTS.map((a, i) => (i === 1 ? { ...a, ok: false } : a)),
        current,
      });
    }

    if (parts[0] === "inbox") {
      const pulls = (inbox[current] ?? []).map((p) => ({
        ...p,
        checks: checksRollup(
          dedupeChecks(
            checksFor(keyOf(p.repo.owner, p.repo.repo, p.number), p.checks, mockStart),
          ),
        ),
        sessionId: latestSession(p),
      }));
      return send(200, {
        account: current,
        viewer: current,
        pulls,
        fetchedAt: new Date().toISOString(),
        // Additive fields: the first account shows every hint.
        ...(current === ACCOUNTS[0]!.login
          ? {
              truncated: { reviewRequested: true, authored: false, involved: false },
              warnings: ["Some organizations hide their pulls until you authorize the token (SAML)."],
              stale: true,
            }
          : {}),
      });
    }

    if (parts[0] === "repos" && parts[3] === "pulls" && parts[4]) {
      const n = Number(parts[4]);
      const found = findPull(parts[1]!, parts[2]!, n);
      if (!found) return send(404, { error: "pull request not found" });
      if (parts[5] === "checks") {
        const checks = dedupeChecks(
          checksFor(keyOf(parts[1]!, parts[2]!, n), found.checks, mockStart),
        );
        return send(200, {
          rollup: checksRollup(checks),
          checks,
          headSha: "0123abc",
          fetchedAt: new Date().toISOString(),
        });
      }
      return send(200, {
        pull: {
          ...found,
          sessionId: latestSession(found),
          body: [
            "<!-- Thanks for the PR! Fill in the template. -->",
            "## Summary",
            "",
            "Moves settlement out of the request path. A scheduled job now closes each market and posts one ledger entry per prediction, so a crash can no longer pay a stake twice.",
            "",
            "<img src=x onerror=\"window.__pwned = 1\"> **Not rendered as HTML.**",
            "",
            "## Test plan",
            "",
            "- `pnpm test` covers the ledger and the job",
            "- Ran the job against a staging copy of the markets table",
            "- Checked that a killed job resumes without a double payout",
            "",
            "Closes #11. Follow-up: add the admin route to the audit log, then drop the old settle endpoint once the dashboard stops calling it. ".repeat(3),
          ].join("\n"),
        },
      });
    }

    if (parts[0] === "repos" && parts[3] === "pulls") {
      const known = allPulls().filter(
        (p) =>
          `${p.repo.owner}/${p.repo.repo}`.toLowerCase() ===
          `${parts[1]}/${parts[2]}`.toLowerCase(),
      );
      if (known.length)
        return send(200, {
          pulls: known.map((p) => ({ ...p, sessionId: latestSession(p) })),
        });
      return send(200, {
        pulls: [
          {
            number: 14,
            title: ready.session.pr!.title,
            author: { login: "ekjackson", avatarUrl: null },
            state: "open",
          },
          {
            number: 9,
            title: "WIP: market maker bot",
            author: { login: "octocat", avatarUrl: null },
            state: "draft",
          },
        ],
      });
    }

    if (parts[0] !== "sessions") return send(404, { error: "not found" });

    if (parts.length === 1) {
      if (method === "POST") {
        const target = String(body.target ?? "");
        if (!/^[\w.-]+\/[\w.-]+#\d+$|github\.com\/.+\/pull\/\d+/.test(target)) {
          return send(400, {
            error: `Cannot read "${target}" as owner/repo#n or a PR URL.`,
          });
        }
        const account = String(body.account ?? current);
        const m =
          /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target) ??
          /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(target);
        const pull = m ? findPull(m[1]!, m[2]!, Number(m[3])) : undefined;
        return send(201, { id: startRun(ready, pull, account) });
      }
      const list: SessionSummary[] = [...sessions.values()]
        .map((e) => (advance(e), e))
        .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
        .map(({ session: s, findings, human }) => ({
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
            findings: findings.length,
            chapters: s.guide.value?.chapters.length ?? 0,
          },
          account: s.account,
          authorAvatarUrl: s.pr?.authorAvatarUrl ?? null,
          state: s.pr?.state ?? "open",
          reviewedChapters: Object.values(human.chapters).filter(Boolean)
            .length,
        }));
      return send(200, { sessions: list });
    }

    const entry = sessions.get(parts[1]!);
    if (!entry) return send(404, { error: "session not found" });
    advance(entry);
    const { session, human } = entry;
    const sub = parts[2];

    if (!sub && method === "GET") {
      return send(200, { session, human, findings: entry.findings });
    }
    if (sub === "checks" && method === "GET") {
      const pull = findPull(session.repo.owner, session.repo.repo, session.prNumber);
      const checks = dedupeChecks(
        checksFor(
          keyOf(session.repo.owner, session.repo.repo, session.prNumber),
          pull?.checks ?? null,
          mockStart,
        ),
      );
      return send(200, {
        rollup: checksRollup(checks),
        checks,
        headSha: session.pr?.headSha ?? "",
        fetchedAt: new Date().toISOString(),
      });
    }
    if (sub === "account" && method === "PUT") {
      const login = String(body.login ?? "");
      if (!ACCOUNTS.some((a) => a.login === login))
        return send(400, { error: `unknown account: ${login}` });
      session.account = login;
      return send(200, { account: login });
    }
    if (sub === "rerun" && method === "POST") {
      if (session.status !== "ready" && session.status !== "failed")
        return send(409, { error: "the session is still running" });
      const id = startRun(entry);
      sessions.get(id)!.human = structuredClone(human);
      return send(201, { id });
    }
    if (sub === "chapters" && method === "PUT") {
      human.chapters[parts[3]!] = Boolean(body.reviewed);
      if (!body.reviewed) delete human.chapters[parts[3]!];
      return send(200, { human });
    }
    if (sub === "files" && method === "PUT") {
      const path = String(body.path);
      if (body.viewed) human.files[path] = true;
      else delete human.files[path];
      return send(200, { human });
    }
    if (sub === "findings" && method === "PUT") {
      const id = parts[3]!;
      if (!entry.findings.some((f) => f.id === id)) {
        return send(404, { error: "unknown finding" });
      }
      if (body.verdict === null) delete human.verdicts[id];
      else
        human.verdicts[id] = {
          verdict: body.verdict as "agree",
          note: String(body.note ?? ""),
          updatedAt: new Date().toISOString(),
        };
      return send(200, { human });
    }
    if (sub === "comments" && method === "POST") {
      const text = String(body.body ?? "").trim();
      if (!text) return send(400, { error: "comment body is empty" });
      human.comments.push({
        id: `hc-${Date.now().toString(36)}`,
        path: String(body.path),
        line: Number(body.line),
        body: text,
        createdAt: new Date().toISOString(),
      });
      return send(201, { human });
    }
    if (sub === "comments" && method === "DELETE") {
      const before = human.comments.length;
      human.comments = human.comments.filter((c) => c.id !== parts[3]);
      if (human.comments.length === before)
        return send(404, { error: "unknown comment" });
      return send(200, { human });
    }
    if (sub === "publish") {
      if (session.status !== "ready")
        return send(409, { error: "session is not ready" });
      const event = (url.searchParams.get("event") ??
        body.event ??
        "COMMENT") as ReviewEvent;
      if (method === "GET")
        return send(200, { preview: compose(entry, event) });
      if (body.confirm !== true)
        return send(400, { error: "confirm: true is required" });
      session.publishedAt = new Date().toISOString();
      return send(200, { ok: true, publishedAt: session.publishedAt });
    }
    if (sub === "discuss") {
      const pr = session.pr!;
      const guide = session.guide.value;
      const prompt = [
        `Help me review ${session.repo.owner}/${session.repo.repo}#${session.prNumber} (${pr.url}). Check out branch ${pr.headRef} (base ${pr.baseRef}) in a worktree. Here is the guide:`,
        "",
        guide?.overview.context ?? "(no guide)",
        "",
        ...(guide?.chapters.map(
          (c, i) => `${i + 1}. ${c.title}: ${c.summary}`,
        ) ?? []),
        "",
        "Agent findings:",
        ...entry.findings.map(
          (f) =>
            `- [${f.id}] ${f.path}:${f.line} (${f.severity}) ${f.body.split("\n")[0]} — my verdict: ${human.verdicts[f.id]?.verdict ?? "none"}`,
        ),
        "",
        "Answer my questions about this change; do not post to GitHub.",
      ].join("\n");
      return send(200, { prompt });
    }
    return send(404, { error: "not found" });
  };
}

function compose(entry: FixtureSession, event: ReviewEvent): ComposedReview {
  const { session, human, findings } = entry;
  const files = session.pr?.files ?? [];
  const postable = new Map(
    files.map((f) => [f.path, newSideLines(parsePatch(f.patch))]),
  );
  const onDiff = (path: string, line: number) =>
    postable.get(path)?.has(line) ?? false;
  const comments: ComposedReview["comments"] = [];
  const skipped: ComposedReview["skipped"] = [];
  const rejected: string[] = [];

  for (const c of human.comments) {
    if (onDiff(c.path, c.line))
      comments.push({ path: c.path, line: c.line, body: c.body });
    else
      skipped.push({
        kind: "human",
        path: c.path,
        line: c.line,
        reason: "line is not on the diff",
      });
  }
  const counts = { agree: 0, disagree: 0, unsure: 0, unchecked: 0 };
  for (const f of findings) {
    const v = human.verdicts[f.id];
    counts[v?.verdict ?? "unchecked"] += 1;
    if (v?.verdict === "disagree") {
      rejected.push(
        `- \`${f.path}:${f.line}\` (${f.severity}) ${f.body.split("\n")[0]} — **Reviewer:** ${v.note || "no reason given"}`,
      );
      continue;
    }
    const label =
      v?.verdict === "agree"
        ? "reviewer agrees"
        : v?.verdict === "unsure"
          ? "reviewer unsure"
          : "not yet checked by a human";
    const note = v?.note ? `\n\n> Reviewer: ${v.note}` : "";
    const text = `<!-- agent-workflows -->\n**Agent finding · ${f.severity} · ${label}**\n\n${f.body}${note}`;
    if (onDiff(f.path, f.line))
      comments.push({ path: f.path, line: f.line, body: text });
    else
      skipped.push({
        kind: "agent",
        path: f.path,
        line: f.line,
        reason: "line is not on the diff",
      });
  }

  const chapters = session.guide.value?.chapters ?? [];
  const body = [
    "<!-- agent-workflows -->",
    "## Guided review",
    "",
    `${chapters.filter((c) => human.chapters[c.id]).length} of ${chapters.length} chapters and ${files.filter((f) => human.files[f.path]).length} of ${files.length} files reviewed by a human.`,
    "",
    `${human.comments.length} human comments · agree ${counts.agree} · disagree ${counts.disagree} · unsure ${counts.unsure} · unchecked ${counts.unchecked}`,
    ...(session.review.value?.summary
      ? ["", "### Agent summary", "", session.review.value.summary]
      : []),
    ...(rejected.length
      ? ["", "### Agent findings the reviewer rejected", "", ...rejected]
      : []),
    ...(skipped.length
      ? [
          "",
          "### Comments outside the diff",
          "",
          ...skipped.map((s) => `- \`${s.path}:${s.line}\` (${s.kind})`),
        ]
      : []),
  ].join("\n");
  return { event, body, comments, skipped };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}
