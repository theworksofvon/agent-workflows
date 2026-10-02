import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  GitHubRepoStateStore,
  jsonFileState,
} from "../../src/adapters/state/json-file.js";
import { gitExec } from "../../src/adapters/git/exec.js";
import type { GitPort } from "../../src/adapters/git/git.interface.js";
import type { RepoStatePort } from "../../src/adapters/state/state.interface.js";

test("json-file state tracks webhook delivery ids with a bounded window", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  try {
    const state: RepoStatePort = new GitHubRepoStateStore(
      root,
      { owner: "o", repo: "r" },
      { processedCommentKeyLimit: 2, commentBatchHistoryLimit: 5 },
    );
    assert.equal(state.hasSeenDelivery("d1"), false);
    state.markDeliverySeen("d1");
    state.markDeliverySeen("d2");
    state.markDeliverySeen("d3");
    assert.equal(state.hasSeenDelivery("d1"), false);
    assert.equal(state.hasSeenDelivery("d3"), true);
    const reloaded = new GitHubRepoStateStore(
      root,
      { owner: "o", repo: "r" },
      { processedCommentKeyLimit: 2, commentBatchHistoryLimit: 5 },
    );
    assert.equal(reloaded.hasSeenDelivery("d2"), true);
    // Re-marking a known id must not reorder or evict anything.
    reloaded.markDeliverySeen("d3");
    assert.equal(reloaded.hasSeenDelivery("d2"), true);
    reloaded.markDeliverySeen("d4");
    assert.equal(reloaded.hasSeenDelivery("d2"), false);
    assert.equal(reloaded.hasSeenDelivery("d4"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitExec satisfies GitPort", () => {
  const port: GitPort = gitExec;
  assert.equal(typeof port.prepareWorkdir, "function");
  assert.equal(typeof port.pushBranch, "function");
});

test("jsonFileState builds a per-repo store from config", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  try {
    const config = {
      stateDir: root,
      processedCommentKeyLimit: 5,
      commentBatchHistoryLimit: 5,
    } as Config;
    const factory = jsonFileState(config);
    factory({ owner: "o", repo: "r" }).markDeliverySeen("d1");
    assert.equal(
      factory({ owner: "o", repo: "r" }).hasSeenDelivery("d1"),
      true,
    );
    assert.equal(
      factory({ owner: "o", repo: "other" }).hasSeenDelivery("d1"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
