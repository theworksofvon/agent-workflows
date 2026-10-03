import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../../src/config.js";
import { GitHubClient } from "../../src/adapters/github/octokit.js";
import { jsonFileState } from "../../src/adapters/state/json-file.js";
import { pollRepos } from "../../src/services/poll.js";
import { gitExec } from "../../src/adapters/git/exec.js";
import type { GitPort } from "../../src/adapters/git/git.interface.js";
import { handleFeedback } from "../../src/services/handle-feedback.js";
import { Daemon } from "../../src/services/daemon.js";
import { receiveDelivery } from "../../src/services/webhook.js";
import { startWebhookListener } from "../../src/adapters/http/listener.js";

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
    const stateFor = jsonFileState(config);
    const poll = () => pollRepos({ config, client, state: stateFor });
    const gitPort: GitPort = {
      ...gitExec,
      prepareWorkdir: (args) =>
        gitExec.prepareWorkdir({ ...args, cloneUrlOverride: remote }),
      cleanupWorkdir: (handle, keep) => {
        gitExec.cleanupWorkdir(handle, keep);
        cleanupCompleted = true;
      },
    };
    const agent = {
      name: "fake-agent",
      async run(input: { workdir: string; prompt: string }) {
        const packetPath = /event packet at (\S+)\./.exec(input.prompt)?.[1];
        const reportPath = /write your report to (\S+)\./i.exec(
          input.prompt,
        )?.[1];
        assert.ok(packetPath && reportPath);
        const packet = JSON.parse(readFileSync(packetPath, "utf8")) as {
          comments: Array<{ key: string; body: string }>;
        };
        assert.deepEqual(
          packet.comments.map((c) => c.body),
          ["first requested change", "second requested change"],
        );
        writeFileSync(join(input.workdir, "agent-output.txt"), "implemented\n");
        writeFileSync(
          reportPath,
          JSON.stringify({
            summary: "done",
            comments: packet.comments.map((c) => ({
              key: c.key,
              decision: "addressed",
            })),
          }),
        );
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
    };

    const batches = await poll();
    assert.equal(batches.length, 1);
    const outcome = await handleFeedback(batches[0], {
      config,
      agent,
      git: gitPort,
      github: client,
      state: stateFor,
    });

    assert.equal(outcome.kind, "pushed");
    assert.equal(postedBodies.length, 1);
    assert.equal(cleanupCompleted, true);
    assert.match(
      postedBodies[0],
      /done\n\n1 commit\(s\) pushed\. Addressed 2, skipped 0, needs a human 0\./,
    );
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

test("webhook delivery runs the full path", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-e2e-hook-"));
  const postedBodies: string[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void handleGitHubRequest(request, response, postedBodies, requests);
  });
  let daemon: Daemon | undefined;

  try {
    const remote = createBareRemote(root);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const config: Config = {
      ...createConfig(root),
      commentBatchMinComments: 1,
      commentBatchWindowSec: 0,
      webhookSecret: "hook-secret",
      port: 0,
    };
    const github = new GitHubClient("test-token", {
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const state = jsonFileState(config);
    const gitPort: GitPort = {
      ...gitExec,
      prepareWorkdir: (args) =>
        gitExec.prepareWorkdir({ ...args, cloneUrlOverride: remote }),
    };
    const agent = {
      name: "fake-agent",
      async run(input: { workdir: string; prompt: string }) {
        const packetPath = /event packet at (\S+)\./.exec(input.prompt)?.[1];
        const reportPath = /write your report to (\S+)\./i.exec(
          input.prompt,
        )?.[1];
        assert.ok(packetPath && reportPath);
        const packet = JSON.parse(readFileSync(packetPath, "utf8")) as {
          comments: Array<{ key: string; body: string }>;
        };
        assert.deepEqual(
          packet.comments.map((c) => c.body),
          ["rename this helper"],
        );
        writeFileSync(join(input.workdir, "hook-output.txt"), "renamed\n");
        writeFileSync(
          reportPath,
          JSON.stringify({
            summary: "renamed",
            comments: packet.comments.map((c) => ({
              key: c.key,
              decision: "addressed",
            })),
          }),
        );
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
    };

    let listenerUrl = "";
    daemon = new Daemon({
      config,
      poll: async () => [],
      handleBatch: (batch) =>
        handleFeedback(batch, { config, agent, git: gitPort, github, state }),
      listener: { host: config.host, port: config.port },
      receiveDelivery: (d) => receiveDelivery(d, { config, github, state }),
      startListener: async (args) => {
        const handle = await startWebhookListener(args);
        listenerUrl = handle.url;
        return handle;
      },
    });
    await daemon.start();

    const body = JSON.stringify({
      action: "created",
      repository: { name: "sample-repo", owner: { login: "local-owner" } },
      comment: {
        id: 42,
        user: { login: "alice" },
        body: "rename this helper",
        created_at: "2026-07-19T00:00:00Z",
        path: "README.md",
        line: 1,
        original_line: 1,
        diff_hunk: "@@ -1 +1 @@",
        pull_request_review_id: 7,
      },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Description",
        draft: false,
        head: { ref: "main", repo: { full_name: "local-owner/sample-repo" } },
        base: { ref: "main", repo: { full_name: "local-owner/sample-repo" } },
      },
    });
    const response = await fetch(`${listenerUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request_review_comment",
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", "hook-secret").update(body).digest("hex"),
      },
      body,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { reason: "accepted" });
    await daemon.idle();

    assert.equal(git(["show", "main:hook-output.txt"], remote), "renamed");
    assert.equal(postedBodies.length, 1);
    assert.match(
      postedBodies[0],
      /renamed\n\n1 commit\(s\) pushed\. Addressed 1, skipped 0, needs a human 0\./,
    );
    assert.ok(
      requests.includes(
        "POST /repos/local-owner/sample-repo/issues/1/comments",
      ),
    );
  } finally {
    await daemon?.stop();
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
    allowedAuthors: null,
    stateDir: join(root, "state"),
    zcodeBin: "zcode",
    claudeCodeBin: "claude",
    codexBin: "codex",
    keepWorkdirs: false,
    host: "127.0.0.1",
    port: 3773,
    webhookSecret: null,
    publicUrl: null,
    tailscaleFunnel: false,
    maxConcurrentRuns: 3,
    autoReview: false,
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
        head: { ref: "main", repo: { full_name: "local-owner/sample-repo" } },
        base: { ref: "main", repo: { full_name: "local-owner/sample-repo" } },
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
