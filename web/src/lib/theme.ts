import { useCallback, useEffect, useState } from "react";

export type ThemeSetting = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_SETTINGS: readonly ThemeSetting[] = [
  "system",
  "light",
  "dark",
];

/** index.html reads this key in an inline script before first paint. */
export const THEME_KEY = "guided-review:theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseThemeSetting(
  raw: string | null | undefined,
): ThemeSetting {
  return THEME_SETTINGS.includes(raw as ThemeSetting)
    ? (raw as ThemeSetting)
    : "system";
}

export function resolveTheme(
  setting: ThemeSetting,
  prefersDark: boolean,
): Theme {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

/**
 * The stored theme setting. Applies the `dark` class on <html>, and while the
 * setting is "system" it follows the OS preference as it changes.
 */
export function useTheme(): [ThemeSetting, (setting: ThemeSetting) => void] {
  const [setting, setSetting] = useState<ThemeSetting>(() =>
    parseThemeSetting(readStorage(THEME_KEY)),
  );

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        resolveTheme(setting, media.matches) === "dark",
      );
    apply();
    if (setting !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [setting]);

  const update = useCallback((next: ThemeSetting) => {
    writeStorage(THEME_KEY, next);
    setSetting(next);
  }, []);

  return [setting, update];
}

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the setting lasts for this page only.
  }
}
