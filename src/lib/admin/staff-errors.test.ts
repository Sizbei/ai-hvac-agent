import { describe, expect, it } from "vitest";
import { staffErrorMessage } from "./staff-errors";

describe("staffErrorMessage", () => {
  it("maps codes to human copy, not the server message", () => {
    const msg = staffErrorMessage(
      { error: { code: "SEAT_LIMIT_REACHED", message: "Your plan's staff limit…" } },
      "x",
    );
    expect(msg).toMatch(/no free seats/);
    expect(staffErrorMessage({ error: { code: "LAST_ADMIN", message: "Cannot remove" } }, "x")).toMatch(/last active admin/);
  });

  it("shows the platform-owner copy for PLATFORM_PROTECTED", () => {
    expect(
      staffErrorMessage({ error: { code: "PLATFORM_PROTECTED" } }, "x"),
    ).toBe(
      "This account is managed by the platform owner and can\u2019t be changed here.",
    );
  });

  it("uses the fallback for unknown codes and bad bodies", () => {
    expect(staffErrorMessage({ error: { code: "INTERNAL_ERROR" } }, "Couldn't save.")).toBe("Couldn't save.");
    expect(staffErrorMessage(null, "Couldn't save.")).toBe("Couldn't save.");
  });
});
