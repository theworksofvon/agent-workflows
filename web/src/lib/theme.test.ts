import { describe, expect, it } from "vitest";
import { parseThemeSetting, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("follows the OS preference for the system setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS preference for an explicit setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("parseThemeSetting", () => {
  it("keeps a known setting and falls back to system otherwise", () => {
    expect(parseThemeSetting("dark")).toBe("dark");
    expect(parseThemeSetting("light")).toBe("light");
    expect(parseThemeSetting(null)).toBe("system");
    expect(parseThemeSetting("sepia")).toBe("system");
  });
});
