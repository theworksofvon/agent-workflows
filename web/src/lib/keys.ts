/** The parts of a DOM element that decide whether it takes typed text. */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "email",
  "number",
  "password",
  "tel",
]);

/**
 * True when a key press belongs to a text field, so page shortcuts must not
 * act on it. Checkboxes and radios keep focus after a click but take no
 * text, so they must not block shortcuts.
 */
export function isTextEntry(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // An <input> without a type attribute is a text field.
  return TEXT_INPUT_TYPES.has((target.type || "text").toLowerCase());
}

/**
 * The index a menu moves its focus to for an arrow key, Home, or End.
 * Arrows wrap around. Returns null for any other key.
 */
export function menuStep(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (current + 1 + count) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  return null;
}
