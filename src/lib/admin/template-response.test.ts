import { describe, expect, it } from "vitest";
import {
  parseTemplatesResponse,
  templateDeleteErrorMessage,
} from "./template-response";

describe("parseTemplatesResponse", () => {
  it("reads templates from the success envelope", () => {
    const body = { success: true, data: { templates: [{ id: "a" }, { id: "b" }] } };
    expect(parseTemplatesResponse<{ id: string }>(body).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("ignores a top-level templates key (the old, wrong path)", () => {
    expect(parseTemplatesResponse({ templates: [{ id: "a" }] })).toEqual([]);
  });

  it("returns [] for an error envelope or junk", () => {
    expect(parseTemplatesResponse({ success: false, error: { code: "X", message: "m" } })).toEqual([]);
    expect(parseTemplatesResponse(null)).toEqual([]);
    expect(parseTemplatesResponse({ success: true, data: { templates: "nope" } })).toEqual([]);
  });
});

describe("templateDeleteErrorMessage", () => {
  it("maps send history to human copy", () => {
    const msg = templateDeleteErrorMessage({
      success: false,
      error: { code: "HAS_SEND_HISTORY", message: "raw server text" },
    });
    expect(msg).toMatch(/Deactivate it instead/);
    expect(msg).not.toContain("raw server text");
  });

  it("falls back for unknown codes and bad bodies", () => {
    const fallback = "Couldn't delete the template. Please try again.";
    expect(templateDeleteErrorMessage({ success: false, error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } })).toBe(fallback);
    expect(templateDeleteErrorMessage({})).toBe(fallback);
    expect(templateDeleteErrorMessage(null)).toBe(fallback);
  });
});
