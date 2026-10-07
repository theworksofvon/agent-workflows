import { describe, expect, it } from "vitest";
import { isTextEntry, menuStep } from "./keys";

describe("isTextEntry", () => {
  it("blocks shortcuts in text inputs, textareas, selects, and editable content", () => {
    for (const type of [
      "text",
      "search",
      "url",
      "email",
      "number",
      "password",
      "",
    ]) {
      expect(isTextEntry({ tagName: "INPUT", type })).toBe(true);
    }
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("lets shortcuts through from checkboxes, radios, buttons, and the page", () => {
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "BODY", isContentEditable: false })).toBe(
      false,
    );
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("menuStep", () => {
  it("moves with the arrows and wraps at both ends", () => {
    expect(menuStep("ArrowDown", 0, 3)).toBe(1);
    expect(menuStep("ArrowDown", 2, 3)).toBe(0);
    expect(menuStep("ArrowUp", 0, 3)).toBe(2);
    expect(menuStep("ArrowUp", -1, 3)).toBe(2);
    expect(menuStep("ArrowDown", -1, 3)).toBe(0);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(menuStep("Home", 2, 3)).toBe(0);
    expect(menuStep("End", 0, 3)).toBe(2);
    expect(menuStep("a", 0, 3)).toBeNull();
    expect(menuStep("ArrowDown", 0, 0)).toBeNull();
  });
});
