import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { menuStep } from "../lib/keys";

const GAP = 6;
const MARGIN = 8;
const MENU_ITEMS = '[role^="menuitem"]';
const FOCUSABLE = `${MENU_ITEMS}, a[href], button:not([disabled])`;

/** True while any popover or menu is on screen. */
export function isPopoverOpen(): boolean {
  return document.querySelector(".popover") !== null;
}

/**
 * A panel under a trigger, rendered into `document.body` so the sidebar's
 * scroll box does not clip it. Focus moves into the panel when it opens.
 * The arrow keys move between menu items. A click outside, Escape, a
 * scroll of the page, or a resize closes it.
 */
export function Popover({
  anchor,
  open,
  onClose,
  align = "start",
  width,
  className = "",
  label,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  width?: number;
  className?: string;
  /** The accessible name of the panel. */
  label: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    const p = panel.current?.getBoundingClientRect();
    if (!a || !p) return;
    const w = p.width;
    let left = align === "end" ? a.right - w : a.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    let top = a.bottom + GAP;
    if (
      top + p.height > window.innerHeight - MARGIN &&
      a.top - GAP - p.height > MARGIN
    )
      top = a.top - GAP - p.height;
    setPos({ top, left });
  }, [open, anchor, align]);

  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    const target =
      panel.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      ) ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? panel.current)?.focus();
  }, [placed]);

  function onPanelKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(panel.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []),
    ];
    const next = menuStep(
      e.key,
      items.indexOf(document.activeElement as HTMLElement),
      items.length,
    );
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      anchor.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (panel.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      className={`popover ${className}`}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onPanelKey}
      style={{
        width,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Open state and the anchor ref for one popover. */
export function usePopover<T extends HTMLElement>() {
  const anchor = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { anchor, open, close, toggle };
}
