/** A plain JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message of a thrown Error, or the thrown value as text. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
