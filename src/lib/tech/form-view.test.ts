import { describe, it, expect } from "vitest";
import { buildFormsCard, unsubmittedRequired, type FormRowIn, type SubmissionRowIn, type TechFormsView } from "./form-view";

const V1 = "visit-1";
const V2 = "visit-2";
const f = (id: string, over: Partial<FormRowIn> = {}): FormRowIn => ({ id, name: id, description: null, required: false, active: true, applies: true, ...over });
const s = (formId: string, appointmentId: string, over: Partial<SubmissionRowIn> = {}): SubmissionRowIn => ({
  id: `s-${formId}-${appointmentId}`, formId, appointmentId, appointmentNumber: appointmentId === V1 ? 1 : 2, status: "draft", revision: 1,
  hasAnswers: true, erased: false, updatedAt: "2026-11-07T10:00:00.000Z", submittedAt: null, submittedByName: null, visitCounts: true, ...over,
});

describe("buildFormsCard (spec §6, §7.2)", () => {
  it("lists active applicable forms plus forms with a row here; others go to otherForms", () => {
    const out = buildFormsCard(V2, [f("Applies"), f("Archived with row", { active: false }), f("Archived"), f("Other", { applies: false })].map((x) => (x.id === "Archived" ? { ...x, active: false } : x)), [s("Archived with row", V2)]);
    expect(out.forms.map((x) => x.formId)).toEqual(["Applies", "Archived with row"]);
    expect(out.otherForms).toEqual([{ formId: "Other", name: "Other" }]);
  });

  it("submittedOn = the newest submitted copy on another counting visit, only when this visit has none", () => {
    const sub = (at: string, over: Partial<SubmissionRowIn> = {}) => s("M", V1, { status: "submitted", submittedAt: at, ...over });
    const out = buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z")]);
    expect(out.forms[0]!.submittedOn).toEqual({ appointmentId: V1, appointmentNumber: 1, submittedAt: "2026-11-06T10:00:00.000Z" });
    expect(buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z", { visitCounts: false })]).forms[0]!.submittedOn).toBeNull();
    const both = buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z"), s("M", V2, { status: "submitted", submittedAt: "2026-11-07T10:00:00.000Z" })]);
    expect(both.forms[0]!.submittedOn).toBeNull();
    expect(both.forms[0]!.submission?.status).toBe("submitted");
  });

  it("orders required-and-not-submitted-anywhere first, then by name", () => {
    const out = buildFormsCard(V1, [f("b"), f("c", { required: true }), f("a", { required: true })], [s("a", V1, { status: "submitted", submittedAt: "2026-11-07T10:00:00.000Z" })]);
    expect(out.forms.map((x) => x.formId)).toEqual(["c", "a", "b"]);
  });
});

describe("unsubmittedRequired", () => {
  it("required forms with no submitted copy here or elsewhere", () => {
    const view = {
      forms: [
        { formId: "a", name: "A", description: null, required: true, submission: null, submittedOn: null },
        { formId: "b", name: "B", description: null, required: true, submission: null, submittedOn: { appointmentId: V1, appointmentNumber: 1, submittedAt: "x" } },
        { formId: "c", name: "C", description: null, required: false, submission: null, submittedOn: null },
      ],
    } as unknown as TechFormsView;
    expect(unsubmittedRequired(view)).toEqual([{ formId: "a", name: "A" }]);
    expect(unsubmittedRequired(null)).toEqual([]);
  });
});
