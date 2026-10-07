import { describe, expect, it } from "vitest";
import { withSkillHeader } from "./discuss";

describe("withSkillHeader", () => {
  it("names the skill, the app, and the session before the prompt", () => {
    const text = withSkillHeader("http://127.0.0.1:4773", "abc", "Help me");
    expect(text.split("\n")).toEqual([
      "Use the guided-review skill. App: http://127.0.0.1:4773 · session: abc",
      "",
      "Help me",
    ]);
  });
});
