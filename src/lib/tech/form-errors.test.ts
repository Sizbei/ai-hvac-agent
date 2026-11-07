import { describe, it, expect } from "vitest";
import { isStorable } from "@/lib/http/idempotency";
import { FORM_REASON, formReasonResult } from "./form-errors";

describe("form reason results (spec §4.3, §8)", () => {
  it("stored codes are exactly the terminal submit answers", () => {
    const stored = Object.values(FORM_REASON).filter((s) => isStorable(s.status, { success: false, error: { message: "", code: s.code } })).map((s) => s.code);
    expect([...new Set(stored)].sort()).toEqual(["ANSWERS_REMOVED", "ANSWERS_UNREADABLE", "CUSTOMER_REMOVED", "FORM_INCOMPLETE", "FORM_SUBMITTED", "INVALID_INPUT"]);
  });

  it("details carry ids, a revision or a path only", () => {
    expect(formReasonResult({ ok: false, reason: "stale", revision: 4 }).envelope).toEqual({
      success: false, error: { message: "Someone else changed this form.", code: "STALE", details: { revision: 4 } },
    });
    expect(formReasonResult({ ok: false, reason: "values_too_large" }).envelope).toMatchObject({ error: { code: "INVALID_INPUT", details: { path: ["values"] } } });
    expect(formReasonResult({ ok: false, reason: "form_incomplete", fieldIds: ["f_0000000001"] })).toMatchObject({
      status: 400, envelope: { error: { code: "FORM_INCOMPLETE", details: { fieldIds: ["f_0000000001"] } } },
    });
    expect(formReasonResult({ ok: false, reason: "not_assigned" })).toMatchObject({ status: 403, envelope: { error: { message: "Only a technician on this visit can fill in its forms." } } });
    expect(formReasonResult({ ok: false, reason: "form_changed" }).envelope).toEqual({
      success: false, error: { message: "The office changed this form. Check your answers.", code: "FORM_CHANGED" },
    });
  });
});
