import type { DatabaseSync } from "node:sqlite";

/** Small values the app keeps across restarts, such as the UI account. */
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function sqliteSettings(db: DatabaseSync): SettingsStore {
  return {
    get(key) {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key);
      return row ? (row.value as string) : null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
    delete(key) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    },
  };
}
