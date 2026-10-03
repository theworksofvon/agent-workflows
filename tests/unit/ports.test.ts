import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import type { CommentBatch } from "../../src/domain/events.js";
import {
  openStateDatabase,
  SqliteRepoStateStore,
  sqliteState,
} from "../../src/adapters/state/sqlite.js";
import { gitExec } from "../../src/adapters/git/exec.js";
import type { GitPort } from "../../src/adapters/git/git.interface.js";
import type { RepoStatePort } from "../../src/adapters/state/state.interface.js";

test("sqlite state tracks webhook delivery ids with a bounded window", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  const first = openStateDatabase(root);
  const second = openStateDatabase(root);
  try {
    const state: RepoStatePort = new SqliteRepoStateStore(
      first,
      { owner: "o", repo: "r" },
      { processedCommentKeyLimit: 2, commentBatchHistoryLimit: 5 },
    );
    assert.equal(state.hasSeenDelivery("d1"), false);
    state.markDeliverySeen("d1");
    state.markDeliverySeen("d2");
    state.markDeliverySeen("d3");
    assert.equal(state.hasSeenDelivery("d1"), false);
    assert.equal(state.hasSeenDelivery("d3"), true);
    const reloaded = new SqliteRepoStateStore(
      second,
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
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitExec satisfies GitPort", () => {
  const port: GitPort = gitExec;
  assert.equal(typeof port.prepareWorkdir, "function");
  assert.equal(typeof port.pushBranch, "function");
});

test("sqliteState builds a per-repo store from config", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  try {
    const config = {
      stateDir: root,
      processedCommentKeyLimit: 5,
      commentBatchHistoryLimit: 5,
    } as Config;
    const factory = sqliteState(config);
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

test("sqliteState shares one store per repo", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  try {
    const config = {
      stateDir: root,
      processedCommentKeyLimit: 5,
      commentBatchHistoryLimit: 5,
    } as Config;
    const factory = sqliteState(config);
    const a = factory({ owner: "o", repo: "r" });
    assert.equal(factory({ owner: "o", repo: "r" }), a);
    assert.notEqual(factory({ owner: "o", repo: "other" }), a);
    assert.notEqual(factory({ owner: "p", repo: "r" }), a);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles from one factory do not lose each other's writes", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ports-"));
  try {
    const config = {
      stateDir: root,
      processedCommentKeyLimit: 5,
      commentBatchHistoryLimit: 5,
    } as Config;
    const factory = sqliteState(config);
    const repo = { owner: "o", repo: "r" };
    const a = factory(repo);
    const b = factory(repo);
    a.markBatchCompleted({
      groupKey: "g",
      comments: [{ key: "c1" }],
    } as unknown as CommentBatch);
    b.recordPrHistory(1, {
      batchId: "b1",
      handledAt: "",
      agent: "x",
      exitCode: 0,
      commitCount: 0,
      commentKeys: [],
      summary: "s",
    });
    const reloaded = sqliteState(config)(repo);
    assert.equal(reloaded.hasProcessedComment("c1"), true);
    assert.equal(reloaded.getRecentPrHistory(1, 5).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
