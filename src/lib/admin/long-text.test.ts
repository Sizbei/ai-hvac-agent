import { describe, expect, it } from "vitest";
import { previewText, readableDescription } from "./long-text";

describe("readableDescription", () => {
  it("splits FieldPulse ' | ' joins into paragraphs", () => {
    expect(readableDescription("PM ESTIMATE | Upon arrival, unit off.")).toBe(
      "PM ESTIMATE\n\nUpon arrival, unit off.",
    );
  });
  it("collapses blank-line runs and trailing spaces, keeps single breaks", () => {
    expect(readableDescription("a  \r\n\r\n\r\n\nb\nc ")).toBe("a\n\nb\nc");
  });
  it("leaves a pipe inside a word or without spaces alone", () => {
    expect(readableDescription("20x20|2 filter")).toBe("20x20|2 filter");
  });
  it("handles empty values", () => {
    expect(readableDescription(null)).toBe("");
    expect(readableDescription("   ")).toBe("");
  });
});

describe("previewText", () => {
  it("returns short text whole", () => {
    expect(previewText("short", 10)).toEqual({ text: "short", truncated: false });
  });
  it("cuts at a word boundary and adds an ellipsis", () => {
    expect(previewText("alpha beta gamma delta", 14)).toEqual({ text: "alpha beta…", truncated: true });
  });
  it("hard-cuts one long word rather than showing almost nothing", () => {
    expect(previewText("a supercalifragilistic", 12)).toEqual({ text: "a supercalif…", truncated: true });
  });
  it("never splits an emoji", () => {
    const r = previewText("☎️📞☎️📞 call", 3);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text).not.toContain("�");
  });
});
