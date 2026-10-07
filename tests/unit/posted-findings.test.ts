import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../src/config.js";
import {
  openStateDatabase,
  SqliteRepoStateStore,
  sqliteState,
} from "../../src/adapters/state/sqlite.js";

const repo = { owner: "local-owner", repo: "sample-repo" };
const openDatabases: DatabaseSync[] = [];

function openDb(root: string): DatabaseSync {
  const db = openStateDatabase(join(root, "state"));
  openDatabases.push(db);
  return db;
}

function cleanup(root: string): void {
  for (const db of openDatabases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
}

test("posted findings persist per PR in order, without duplicates, up to the limit", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-posted-"));
  try {
    const state = new SqliteRepoStateStore(openDb(root), repo, 2);
    state.recordPostedFindings(1, []);
    state.recordPostedFindings(1, ["one", "two"]);
    state.recordPostedFindings(1, ["two", "three"]);
    assert.deepEqual(state.getPostedReviewFindingKeys(1), ["two", "three"]);
    assert.deepEqual(state.getPostedReviewFindingKeys(99), []);

    const reloaded = new SqliteRepoStateStore(openDb(root), repo);
    assert.deepEqual(reloaded.getPostedReviewFindingKeys(1), ["two", "three"]);
    const other = new SqliteRepoStateStore(openDb(root), {
      owner: "local-owner",
      repo: "other",
    });
    assert.deepEqual(other.getPostedReviewFindingKeys(1), []);
  } finally {
    cleanup(root);
  }
});

test("a zero limit keeps no posted findings", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-zero-"));
  try {
    const state = new SqliteRepoStateStore(openDb(root), repo, 0);
    state.recordPostedFindings(2, ["gone"]);
    assert.deepEqual(state.getPostedReviewFindingKeys(2), []);
  } finally {
    cleanup(root);
  }
});

test("a write that fails partway leaves the posted findings as they were", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-rollback-"));
  try {
    const db = openDb(root);
    const state = new SqliteRepoStateStore(db, repo);
    state.recordPostedFindings(1, ["kept"]);
    db.exec(`CREATE TRIGGER refuse AFTER INSERT ON posted_review_findings
             WHEN NEW.key = 'bad' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    assert.throws(
      () => state.recordPostedFindings(1, ["new", "bad"]),
      /refused/,
    );
    assert.deepEqual(state.getPostedReviewFindingKeys(1), ["kept"]);
  } finally {
    cleanup(root);
  }
});

test("opening a database drops the tables of the retired feedback bot", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-retired-"));
  const retired = [
    "repos",
    "pr_cursors",
    "comment_groups",
    "processed_comments",
    "seen_deliveries",
    "pr_batch_history",
    "pr_review_runs",
  ];
  try {
    const old = openDb(root);
    for (const table of retired)
      old.exec(`CREATE TABLE ${table} (seq INTEGER PRIMARY KEY)`);
    const tables = openDb(root)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name as string);
    for (const table of retired) assert.equal(tables.includes(table), false);
    assert.equal(tables.includes("posted_review_findings"), true);
    assert.equal(tables.includes("review_sessions"), true);
  } finally {
    cleanup(root);
  }
});

test("sqliteState builds one store per repo from the config", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflows-state-factory-"));
  try {
    const config = { stateDir: root } as Config;
    const factory = sqliteState(config);
    const a = factory(repo);
    const other = { owner: "local-owner", repo: "other" };
    assert.equal(factory(repo), a);
    assert.notEqual(factory(other), a);
    assert.notEqual(factory({ owner: "p", repo: "sample-repo" }), a);
    a.recordPostedFindings(1, ["k"]);
    assert.deepEqual(sqliteState(config)(repo).getPostedReviewFindingKeys(1), [
      "k",
    ]);
    assert.deepEqual(factory(other).getPostedReviewFindingKeys(1), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
