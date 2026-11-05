import { describe, expect, it } from "vitest";
import { noteFor } from "./sheet-note";

describe("noteFor", () => {
  it("pending and skipped read as status (null without a message)", () => {
    expect(noteFor({ status: "pending", message: "Still saving your last tap…" }, "x")).toEqual({
      text: "Still saving your last tap…",
      error: false,
    });
    expect(noteFor({ status: "skipped", message: null }, "x")).toBeNull();
  });
  it("retry and error are alerts with a fallback", () => {
    expect(noteFor({ status: "retry", message: "Try again." }, "x")).toEqual({ text: "Try again.", error: true });
    expect(noteFor({ status: "error", message: null }, "Fallback.")).toEqual({ text: "Fallback.", error: true });
  });
  it("done and dropped have no note", () => {
    expect(noteFor({ status: "done", message: null }, "x")).toBeNull();
    expect(noteFor({ status: "dropped", message: null }, "x")).toBeNull();
  });
});
