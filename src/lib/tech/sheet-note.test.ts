import { describe, expect, it } from "vitest";
import { noteFor, signatureNoteFor } from "./sheet-note";
import { SIGNATURE_DIDNT_SAVE } from "./approval-flow";

describe("signatureNoteFor", () => {
  it("every failure reads the one signature message", () => {
    const want = { text: "The signature didn't save. Try again.", error: true };
    expect(signatureNoteFor({ status: "retry", message: "Your last change may not have saved. Try again." }, SIGNATURE_DIDNT_SAVE)).toEqual(want);
    expect(signatureNoteFor({ status: "error", message: "Internal server error" }, SIGNATURE_DIDNT_SAVE)).toEqual(want);
  });
  it("status lines and success pass through", () => {
    expect(signatureNoteFor({ status: "pending", message: "Still saving your last tap…" }, SIGNATURE_DIDNT_SAVE)).toEqual({
      text: "Still saving your last tap…",
      error: false,
    });
    expect(signatureNoteFor({ status: "done", message: null }, SIGNATURE_DIDNT_SAVE)).toBeNull();
  });
});

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
