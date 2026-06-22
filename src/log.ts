/**
 * Tiny structured logger. Single function, level-prefixed lines.
 * Kept dependency-free on purpose; swap for pino later without touching callers.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ?? "info";

function fmt(level: Level, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  return `${base} ${JSON.stringify(meta)}`;
}

export const log = {
  debug(msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[minLevel] <= LEVELS.debug) console.debug(fmt("debug", msg, meta));
  },
  info(msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[minLevel] <= LEVELS.info) console.log(fmt("info", msg, meta));
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[minLevel] <= LEVELS.warn) console.warn(fmt("warn", msg, meta));
  },
  error(msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[minLevel] <= LEVELS.error) console.error(fmt("error", msg, meta));
  },
};
