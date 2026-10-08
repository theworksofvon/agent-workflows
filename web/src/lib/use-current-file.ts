import { useEffect, useState } from "react";
import { fileAnchor } from "./format";
import { nextCurrentFile } from "./orientation";

/**
 * The path of the file diff at the top of the viewport. A 1px reading line
 * sits `offset` pixels below the top, under the sticky top bar; an
 * IntersectionObserver reports each file diff that crosses it.
 */
export function useCurrentFile(
  paths: readonly string[],
  offset: number,
): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const key = paths.join("\n");

  useEffect(() => {
    setCurrent(null);
    const list = key ? key.split("\n") : [];
    if (!list.length) return;
    const pathOf = new Map(list.map((p) => [fileAnchor(p), p]));
    let observer: IntersectionObserver | null = null;

    function observe() {
      observer?.disconnect();
      const bottom = Math.max(0, window.innerHeight - offset - 1);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const path = pathOf.get(entry.target.id);
            if (!path) continue;
            setCurrent((cur) =>
              nextCurrentFile(list, cur, {
                path,
                entering: entry.isIntersecting,
                below: entry.boundingClientRect.top > offset,
              }),
            );
          }
        },
        { rootMargin: `-${offset}px 0px -${bottom}px 0px` },
      );
      for (const id of pathOf.keys()) {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      }
    }

    observe();
    window.addEventListener("resize", observe);
    return () => {
      window.removeEventListener("resize", observe);
      observer?.disconnect();
    };
  }, [key, offset]);

  return current;
}
