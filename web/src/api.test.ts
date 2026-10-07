import { describe, expect, it } from "vitest";
import { ApiError, needsAccountChoice, optional, toOpenPull } from "./api";

describe("optional", () => {
  it("gives null for a route the server does not have", async () => {
    await expect(
      optional(Promise.reject(new ApiError(404, "not found"))),
    ).resolves.toBeNull();
  });

  it("passes values and other errors through", async () => {
    await expect(optional(Promise.resolve(3))).resolves.toBe(3);
    await expect(
      optional(Promise.reject(new ApiError(500, "boom"))),
    ).rejects.toThrow("boom");
  });
});

describe("toOpenPull", () => {
  it("reads the older and the inbox pull shapes", () => {
    expect(
      toOpenPull({ number: 9, title: "WIP", author: "dj", draft: true }),
    ).toEqual({ number: 9, title: "WIP", author: "dj", draft: true });
    expect(
      toOpenPull({
        number: 4,
        title: "Fix",
        author: { login: "octo", avatarUrl: null },
        state: "draft",
      } as never),
    ).toEqual({ number: 4, title: "Fix", author: "octo", draft: true });
  });
});

describe("needsAccountChoice", () => {
  it("matches only the 409 that asks for an account", () => {
    expect(
      needsAccountChoice(new ApiError(409, "choose the account for this review")),
    ).toBe(true);
    expect(needsAccountChoice(new ApiError(409, "session is not ready"))).toBe(false);
    expect(needsAccountChoice(new ApiError(400, "choose the account"))).toBe(false);
    expect(needsAccountChoice(new Error("choose the account"))).toBe(false);
  });
});
