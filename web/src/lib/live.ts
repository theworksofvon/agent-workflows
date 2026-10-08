import { useEffect, useState } from "react";
import { api } from "../api";
import type { FocusInput, LineRange } from "../types";

/** How long the focus must hold still before the page reports it. */
const FOCUS_DELAY_MS = 500;

/**
 * Calls `reload` each time the server says the session's human state
 * changed, as when an agent records a verdict over MCP. The browser
 * reconnects a dropped stream by itself.
 */
export function useLiveSession(id: string, reload: () => void): void {
  useEffect(() => {
    const source = new EventSource(
      `/api/sessions/${encodeURIComponent(id)}/events`,
    );
    source.addEventListener("changed", reload);
    return () => source.close();
  }, [id, reload]);
}

/** Tells the server what the reviewer has open, for an agent's get_focus. */
export function useFocusReport(review: string, focus: FocusInput | null): void {
  const key = focus ? JSON.stringify(focus) : "";
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => {
      void api
        .setFocus({ review, ...(JSON.parse(key) as FocusInput) })
        .catch(() => {});
    }, FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [review, key]);
}

/** Lines that the reviewer selected inside one file's diff. */
export interface DiffSelection {
  path: string;
  lines: LineRange;
  /** Where the selection ends on screen, for a button beside it. */
  rect: { top: number; left: number };
}

/**
 * The diff lines under the text selection, or null when the selection is
 * empty or leaves a single file. Rows carry `data-line` (the new-side line)
 * and the file section carries `data-path`.
 */
export function useDiffSelection(): DiffSelection | null {
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  useEffect(() => {
    function read() {
      setSelection((prev) => {
        const next = currentSelection();
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    }
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);
  return selection;
}

function currentSelection(): DiffSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const file = closest(range.startContainer, "[data-path]");
  if (!file || file !== closest(range.endContainer, "[data-path]")) return null;
  const rows = [...file.querySelectorAll<HTMLElement>("tr[data-line]")].filter(
    (row) => range.intersectsNode(row),
  );
  if (rows.length === 0) return null;
  const numbers = rows.map((row) => Number(row.dataset.line));
  const box = range.getBoundingClientRect();
  return {
    path: file.dataset.path!,
    lines: { start: Math.min(...numbers), end: Math.max(...numbers) },
    rect: { top: box.bottom, left: box.right },
  };
}

function closest(node: Node, selector: string): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>(selector) ?? null;
}
