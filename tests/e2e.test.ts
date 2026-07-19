import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { GitHubClient } from "../src/github/client.js";
import { githubPoller } from "../src/github/poller.js";
import { prepareWorkdir } from "../src/runner/workdir.js";
import {
  defaultPRCommentWorkflowDependencies,
  prCommentWorkflow,
} from "../src/workflows/pr-comment/index.js";

test("comment delivery runs through HTTP, batching, git, agent, push, and persisted state", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-e2e-"));
  const postedBodies: string[] = [];
  const requests: string[] = [];
  let cleanupCompleted = false;
  const server = createServer((request, response) => {
    void handleGitHubRequest(request, response, postedBodies, requests);
  });

  try {
    const remote = createBareRemote(root);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const config = createConfig(root);
    const client = new GitHubClient("test-token", {
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const source = githubPoller({ config, client });
    const workflow = prCommentWorkflow({
      ...defaultPRCommentWorkflowDependencies,
      prepareWorkdir: (args) =>
        prepareWorkdir({ ...args, cloneUrlOverride: remote }),
      cleanupWorkdir: (handle, keep) => {
        defaultPRCommentWorkflowDependencies.cleanupWorkdir(handle, keep);
        cleanupCompleted = true;
      },
    });
    const agent = {
      name: "fake-agent",
      async run(input: { workdir: string; prompt: string }) {
        assert.match(input.prompt, /first requested change/);
        assert.match(input.prompt, /second requested change/);
        writeFileSync(join(input.workdir, "agent-output.txt"), "implemented\n");
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
    };
    const daemon = new Daemon(config, source, client, agent, {
      getWorkflow: (kind) => (kind === "pr_comment" ? workflow : undefined),
    });

    await daemon.tick();
    await waitFor(() => postedBodies.length === 1 && cleanupCompleted);

    assert.match(postedBodies[0], /Applied changes.*2 comments.*1 commit/);
    assert.equal(git(["show", "main:agent-output.txt"], remote), "implemented");
    const state = JSON.parse(
      readFileSync(
        join(config.stateDir, "github", "local-owner", "sample-repo.json"),
        "utf8",
      ),
    );
    assert.deepEqual(state.pendingCommentGroups, {});
    assert.equal(state.processedCommentKeys.length, 2);
    assert.ok(requests.includes("GET /repos/local-owner/sample-repo/pulls"));
    assert.ok(
      requests.includes(
        "POST /repos/local-owner/sample-repo/issues/1/comments",
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

function createConfig(root: string): Config {
  return {
    githubToken: "test-token",
    repos: [{ owner: "local-owner", repo: "sample-repo" }],
    pollIntervalSec: 5,
    commentBatchWindowSec: 0,
    commentBatchMinComments: 2,
    commentBatchMaxWaitSec: 300,
    prContextHistoryLimit: 5,
    commentBatchHistoryLimit: 20,
    processedCommentKeyLimit: 2000,
    agentRetryDelaySec: 30,
    agentMaxAttempts: 3,
    agent: "codex",
    reviewAdversarialMode: "off",
    reviewAdversarialAgent: "codex",
    processExistingCommentsOnFirstRun: true,
    agentSelfUser: null,
    stateDir: join(root, "state"),
    zcodeBin: "zcode",
    claudeCodeBin: "claude",
    codexBin: "codex",
    keepWorkdirs: false,
  };
}

async function handleGitHubRequest(
  request: IncomingMessage,
  response: ServerResponse,
  postedBodies: string[],
  requests: string[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  requests.push(`${request.method} ${url.pathname}`);

  if (
    request.method === "GET" &&
    url.pathname === "/repos/local-owner/sample-repo/pulls"
  ) {
    sendJson(response, [
      {
        number: 1,
        title: "Test PR",
        body: "Description",
        head: { ref: "main" },
        base: { ref: "main" },
        draft: false,
      },
    ]);
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/repos/local-owner/sample-repo/issues/1/comments"
  ) {
    sendJson(response, [
      {
        id: 10,
        user: { login: "alice" },
        body: "first requested change",
        created_at: "2026-07-19T00:00:00Z",
      },
      {
        id: 11,
        user: { login: "bob" },
        body: "second requested change",
        created_at: "2026-07-19T00:00:01Z",
      },
    ]);
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/repos/local-owner/sample-repo/pulls/1/comments"
  ) {
    sendJson(response, []);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/repos/local-owner/sample-repo/issues/1/comments"
  ) {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    postedBodies.push(String((JSON.parse(body) as { body: string }).body));
    sendJson(response, { id: 100 });
    return;
  }

  response.statusCode = 404;
  sendJson(response, { message: "not found" });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.statusCode ||= 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function createBareRemote(root: string): string {
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  git(["init", "-b", "main", source], root);
  git(["config", "user.name", "Test User"], source);
  git(["config", "user.email", "test@example.com"], source);
  writeFileSync(join(source, "README.md"), "# test\n");
  git(["add", "README.md"], source);
  git(["commit", "-m", "Initial commit"], source);
  git(["clone", "--bare", source, remote], root);
  return remote;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for end-to-end workflow");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
