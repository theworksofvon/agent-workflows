import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * A GitHub stand-in: REST and GraphQL over HTTP, backed by real bare git
 * repositories under `remotes/<owner>/<repo>.git`. The app clones from
 * those through a `url.insteadOf` rule in the test HOME's git config, so
 * the diff that the API reports is the diff that the agents read.
 */
export interface FakePull {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
}

export interface PostedReview {
  path: string;
  token: string;
  body: Record<string, unknown>;
}

export interface FakeGitHub {
  url: string;
  remotes: string;
  posted: PostedReview[];
  /** Pushes `files` as one commit on a new `head` branch and opens a PR. */
  addPull(pull: FakePull, files: Record<string, string>): string;
  close(): Promise<void>;
}

export async function startFakeGitHub(root: string): Promise<FakeGitHub> {
  const remotes = join(root, "remotes");
  const pulls: Array<FakePull & { headSha: string }> = [];
  const posted: PostedReview[] = [];

  const server = createServer((req, res) => {
    void readJson(req).then((body) => {
      const token = String(req.headers.authorization ?? "").replace(
        /^(token|bearer) /i,
        "",
      );
      const reply = route(req.method!, req.url!, token, body);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  const route = (
    method: string,
    url: string,
    token: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } => {
    if (!token.startsWith("tok-"))
      return { status: 401, body: { message: "Bad credentials" } };
    const login = token.slice("tok-".length);
    if (method === "GET" && url === "/user")
      return { status: 200, body: { login, avatar_url: null } };
    if (method === "POST" && url === "/graphql")
      return { status: 200, body: graphql(body) };
    const m =
      /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/files|\/reviews)?/.exec(url);
    const pull = m && find(m[1], m[2], Number(m[3]));
    if (!pull) return { status: 404, body: { message: "Not Found" } };
    if (method === "GET" && m[4] === undefined)
      return {
        status: 200,
        body: {
          number: pull.number,
          title: pull.title,
          body: "Adds a greeting.",
          draft: false,
          head: { ref: pull.headRef, sha: pull.headSha },
          base: { ref: pull.baseRef },
        },
      };
    if (method === "GET" && m[4] === "/files")
      return { status: 200, body: files(pull) };
    if (method === "POST" && m[4] === "/reviews") {
      posted.push({ path: url, token, body });
      return { status: 200, body: { id: posted.length } };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

  const find = (owner: string, repo: string, number: number) =>
    pulls.find(
      (p) => p.owner === owner && p.repo === repo && p.number === number,
    );

  const bare = (p: FakePull) => join(remotes, p.owner, `${p.repo}.git`);

  const files = (pull: FakePull & { headSha: string }) => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: bare(pull), encoding: "utf8" });
    const range = `${pull.baseRef}...${pull.headRef}`;
    return git("diff", "--numstat", range)
      .trim()
      .split("\n")
      .map((row) => {
        const [additions, deletions, filename] = row.split("\t");
        const patch = git("diff", range, "--", filename);
        return {
          filename,
          status: Number(deletions) === 0 ? "added" : "modified",
          additions: Number(additions),
          deletions: Number(deletions),
          patch: patch.slice(patch.indexOf("@@")),
        };
      });
  };

  const card = (pull: FakePull & { headSha: string }) => {
    const changed = files(pull);
    return {
      __typename: "PullRequest",
      number: pull.number,
      title: pull.title,
      url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      updatedAt: "2026-10-07T12:00:00Z",
      additions: changed.reduce((n, f) => n + f.additions, 0),
      deletions: changed.reduce((n, f) => n + f.deletions, 0),
      changedFiles: changed.length,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      author: { login: pull.author, avatarUrl: null },
      repository: { name: pull.repo, owner: { login: pull.owner } },
      commits: {
        nodes: [
          {
            commit: {
              committedDate: "2026-10-07T12:00:00Z",
              author: { name: pull.author, user: { login: pull.author } },
              statusCheckRollup: { state: "SUCCESS" },
            },
          },
        ],
      },
    };
  };

  const graphql = (body: Record<string, unknown>) => {
    const query = String(body.query);
    const vars = body.variables as Record<string, string | number>;
    if (query.includes("search("))
      return {
        data: {
          search: { issueCount: pulls.length, nodes: pulls.map(card) },
        },
      };
    const pull = (number: number) =>
      find(String(vars.owner), String(vars.name), number);
    if (query.includes("pullRequests("))
      return {
        data: {
          repository: {
            pullRequests: {
              nodes: pulls
                .filter((p) => p.owner === vars.owner && p.repo === vars.name)
                .map(card),
            },
          },
        },
      };
    const found = pull(Number(vars.number));
    if (!found)
      return {
        data: { repository: { pullRequest: null } },
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a PullRequest with the number of ${vars.number}.`,
          },
        ],
      };
    if (query.includes("contexts("))
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: found.headSha,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "test",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                              detailsUrl: null,
                              startedAt: "2026-10-07T12:00:00Z",
                              completedAt: "2026-10-07T12:01:00Z",
                              checkSuite: {
                                workflowRun: { workflow: { name: "CI" } },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    return {
      data: {
        repository: {
          pullRequest: {
            ...card(found),
            body: "Adds a greeting.",
            headRefOid: found.headSha,
            isCrossRepository: false,
          },
        },
      },
    };
  };

  const addPull = (pull: FakePull, changes: Record<string, string>) => {
    const remote = bare(pull);
    const work = mkdtempSync(join(root, "work-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, ...COMMITTER },
      }).trim();
    if (!pulls.some((p) => bare(p) === remote)) {
      mkdirSync(remote, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", "-b", pull.baseRef, remote]);
      git("init", "-q", "-b", pull.baseRef);
      writeFileSync(
        join(work, "app.ts"),
        'export function main(): string {\n  return "widget";\n}\n',
      );
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", pull.baseRef);
    } else {
      git("clone", "-q", remote, ".");
    }
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-b", pull.headRef, `origin/${pull.baseRef}`);
    for (const [file, text] of Object.entries(changes))
      writeFileSync(join(work, file), text);
    git("add", ".");
    git("commit", "-q", "-m", pull.title);
    git("push", "-q", remote, pull.headRef);
    const headSha = git("rev-parse", "HEAD");
    pulls.push({ ...pull, headSha });
    return headSha;
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    remotes,
    posted,
    addPull,
    close: () => closeServer(server),
  };
}

const COMMITTER = {
  GIT_AUTHOR_NAME: "octocat",
  GIT_AUTHOR_EMAIL: "octocat@example.com",
  GIT_COMMITTER_NAME: "octocat",
  GIT_COMMITTER_EMAIL: "octocat@example.com",
};

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
