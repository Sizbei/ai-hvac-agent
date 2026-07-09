import { describe, expect, it } from "vitest";

import { resolveLoginMode } from "./login-mode";

describe("resolveLoginMode", () => {
  it("is google-only when OIDC is configured", () => {
    expect(
      resolveLoginMode({ googleEnabled: true, passwordParam: undefined }),
    ).toBe("google");
  });

  it("falls back to password when OIDC is not configured", () => {
    expect(
      resolveLoginMode({ googleEnabled: false, passwordParam: undefined }),
    ).toBe("password");
  });

  it("honors the ?password=1 break-glass even when Google is configured", () => {
    expect(resolveLoginMode({ googleEnabled: true, passwordParam: "1" })).toBe(
      "password",
    );
  });

  it("ignores ?password values other than 1", () => {
    expect(
      resolveLoginMode({ googleEnabled: true, passwordParam: "0" }),
    ).toBe("google");
    expect(
      resolveLoginMode({ googleEnabled: true, passwordParam: "true" }),
    ).toBe("google");
  });

  it("ignores repeated ?password params (string[] from Next searchParams)", () => {
    expect(
      resolveLoginMode({ googleEnabled: true, passwordParam: ["1", "1"] }),
    ).toBe("google");
  });

  it("break-glass is meaningless when Google is off (already password)", () => {
    expect(resolveLoginMode({ googleEnabled: false, passwordParam: "1" })).toBe(
      "password",
    );
  });
});
