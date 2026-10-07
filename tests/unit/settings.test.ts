import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDatabase } from "../../src/adapters/state/sqlite.js";
import { sqliteSettings } from "../../src/adapters/state/settings.js";

test("settings store a value per key and keep the last write across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "settings-"));
  try {
    const db = openStateDatabase(join(root, "state"));
    const settings = sqliteSettings(db);
    assert.equal(settings.get("ui.account"), null);
    settings.set("ui.account", "alice");
    settings.set("ui.account", "bob");
    db.close();
    const reopened = openStateDatabase(join(root, "state"));
    assert.equal(sqliteSettings(reopened).get("ui.account"), "bob");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
