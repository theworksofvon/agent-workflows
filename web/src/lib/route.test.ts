import { describe, expect, it } from "vitest";
import { parseRoute, pullHref, sessionHref } from "./route";

describe("routes", () => {
  it("reads home for an empty or unknown hash", () => {
    expect(parseRoute("")).toEqual({ page: "home" });
    expect(parseRoute("#/nope")).toEqual({ page: "home" });
  });

  it("reads a session with its tab and chapter", () => {
    expect(parseRoute("#/s/abc/guide/settle-core")).toEqual({
      page: "session",
      id: "abc",
      tab: "guide",
      chapter: "settle-core",
    });
    expect(parseRoute("#/s/abc/bogus")).toMatchObject({ tab: "overview" });
  });

  it("round-trips the links it builds", () => {
    for (const href of [
      sessionHref("a b"),
      sessionHref("x", "diff"),
      sessionHref("x", "guide", "ch/1"),
    ]) {
      const route = parseRoute(href);
      expect(route.page).toBe("session");
    }
    expect(parseRoute(sessionHref("x", "guide", "ch/1"))).toMatchObject({
      chapter: "ch/1",
    });
  });

  it("reads a pull request preview and needs a numeric number", () => {
    expect(parseRoute(pullHref("EK-LABS", "pluto.web", 14))).toEqual({
      page: "pull",
      owner: "EK-LABS",
      repo: "pluto.web",
      number: 14,
    });
    expect(parseRoute("#/pr/ek/pluto/abc")).toEqual({ page: "home" });
  });
});
