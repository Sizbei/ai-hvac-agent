import { describe, it, expect } from "vitest";
import { techLoginErrorCopy } from "./login-copy";

describe("techLoginErrorCopy", () => {
  it("wrong email or password", () => {
    expect(techLoginErrorCopy(401, "INVALID_CREDENTIALS")).toBe("That email and password don't match.");
  });
  it("rate limited", () => {
    expect(techLoginErrorCopy(429, "RATE_LIMITED")).toBe("Too many tries. Wait a minute, then try again.");
  });
  it("network failure", () => {
    expect(techLoginErrorCopy(null, null)).toBe("Couldn't reach the server. Try again.");
  });
  it("anything else is generic, never server text", () => {
    expect(techLoginErrorCopy(500, "LOGIN_FAILED")).toBe("Couldn't sign you in. Try again.");
    expect(techLoginErrorCopy(403, "FORBIDDEN_ORIGIN")).toBe("Couldn't sign you in. Try again.");
  });
});
