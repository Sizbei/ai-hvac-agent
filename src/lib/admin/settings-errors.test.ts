import { describe, expect, it } from "vitest";
import { settingsFieldErrorCopy, settingsSaveErrorMessage } from "./settings-errors";

describe("settingsFieldErrorCopy", () => {
  it("maps nested paths", () => {
    expect(settingsFieldErrorCopy(["afterHoursConfig", "startHour"])).toMatch(/0 to 23/);
    expect(settingsFieldErrorCopy(["businessInfo", "email"])).toMatch(/contact email/);
  });

  it("uses the parent's copy for array entries", () => {
    expect(settingsFieldErrorCopy(["allowedOrigins", 3])).toMatch(/allowed websites/);
  });

  it("returns null for an unknown path", () => {
    expect(settingsFieldErrorCopy(["mystery"])).toBeNull();
  });
});

describe("settingsSaveErrorMessage", () => {
  it("uses the failing field's copy, never the zod text", () => {
    const msg = settingsSaveErrorMessage({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid settings: Too big: expected number to be <=23",
        details: { path: ["afterHoursConfig", "startHour"] },
      },
    });
    expect(msg).not.toMatch(/Too big/);
    expect(msg).toMatch(/whole hour/);
  });

  it("falls back to generic copy", () => {
    expect(settingsSaveErrorMessage({ error: { code: "VALIDATION_ERROR", message: "x" } })).toMatch(/aren't valid/);
    expect(settingsSaveErrorMessage({ error: { code: "INTERNAL_ERROR", message: "boom" } })).toBe(
      "Couldn't save settings. Please try again.",
    );
    expect(settingsSaveErrorMessage(null)).toBe("Couldn't save settings. Please try again.");
  });

  it("has rate-limit copy", () => {
    expect(settingsSaveErrorMessage({ error: { code: "RATE_LIMITED" } })).toMatch(/Wait a minute/);
  });
});
