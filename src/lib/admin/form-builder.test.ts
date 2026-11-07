import { describe, it, expect } from "vitest";
import {
  addField, afterReplay, blankField, BUILDER_COPY, builderErrors, changeType, firstSaveOutcome, fromDefinition, moveField, newBuilderForm,
  newFieldId, newOptionId, removeField, restoreField, toDefinition, visibleErrors, type BuilderField, type BuilderForm,
} from "./form-builder";
import { formDefinitionSchema } from "@/lib/forms/form-schema";

let seed = 0;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const field = (over: Partial<BuilderField> = {}): BuilderField => ({ ...blankField("checkbox", rnd), label: "Filter changed", ...over });
const form = (over: Partial<BuilderForm> = {}): BuilderForm => ({ ...newBuilderForm(rnd), name: "Maintenance checklist", fields: [field()], ...over });
const messages = (f: BuilderForm) => builderErrors(f).map((e) => e.message);

describe("ids", () => {
  it("fields f_ + 10, options o_ + 8, lowercase alphanumerics", () => {
    expect(newFieldId(rnd)).toMatch(/^f_[a-z0-9]{10}$/);
    expect(newOptionId(rnd)).toMatch(/^o_[a-z0-9]{8}$/);
  });
});

describe("list helpers (spec §7.1)", () => {
  it("new form = empty name and one blank Checkbox", () => {
    const f = newBuilderForm(rnd);
    expect(f.name).toBe("");
    expect(f.fields.map((x) => [x.type, x.label])).toEqual([["checkbox", ""]]);
  });
  it("add below, move up / down, remove then undo restores the position", () => {
    const a = field({ label: "A" });
    const b = field({ label: "B" });
    const added = addField([a, b], 0, rnd);
    expect(added.map((x) => x.label)).toEqual(["A", "", "B"]);
    expect(moveField([a, b], 1, -1).map((x) => x.label)).toEqual(["B", "A"]);
    expect(moveField([a, b], 0, -1).map((x) => x.label)).toEqual(["A", "B"]);
    const r = removeField([a, b], 0);
    expect(r.fields.map((x) => x.label)).toEqual(["B"]);
    expect(restoreField(r.fields, r.removed!).map((x) => x.label)).toEqual(["A", "B"]);
  });
  it("changeType keeps label and help, forces heading's required off, drops extras, seeds two choice options", () => {
    const n = field({ type: "number", required: true, help: "h", unit: "psi", usualMin: "5" });
    expect(changeType(n, "heading", rnd)).toMatchObject({ type: "heading", label: "Filter changed", help: "h", required: false, unit: "", usualMin: "" });
    expect(changeType(n, "yes_no", rnd)).toMatchObject({ required: true, allowNa: false });
    const c = changeType(n, "choice", rnd);
    expect(c.options).toHaveLength(2);
    expect(c.options.every((o) => o.label === "")).toBe(true);
  });
});

describe("builderErrors (spec §8): one message per rule", () => {
  it("a valid form has none and converts to a schema-valid definition", () => {
    const f = form();
    expect(builderErrors(f)).toEqual([]);
    expect(formDefinitionSchema.safeParse(toDefinition(f)).success).toBe(true);
  });
  it("header rules", () => {
    expect(messages(form({ name: "  " }))).toContain(BUILDER_COPY.name);
    expect(messages(form({ name: "x".repeat(81) }))).toContain(BUILDER_COPY.nameLong);
    expect(messages(form({ description: "x".repeat(301) }))).toContain(BUILDER_COPY.descriptionLong);
    expect(messages(form({ appliesTo: "some", jobTypeIds: [] }))).toContain(BUILDER_COPY.jobTypes);
    expect(messages(form({ fields: [field({ type: "heading" })] }))).toContain(BUILDER_COPY.noQuestion);
    expect(messages(form({ fields: Array.from({ length: 61 }, () => field()) }))).toContain(BUILDER_COPY.tooMany);
    expect(messages(form({ fields: Array.from({ length: 11 }, () => field({ type: "long_text" })) }))).toContain(BUILDER_COPY.longText);
  });
  it("field rules", () => {
    expect(messages(form({ fields: [field({ label: "" })] }))).toContain(BUILDER_COPY.label);
    expect(messages(form({ fields: [field({ label: "x".repeat(121) })] }))).toContain(BUILDER_COPY.labelLong);
    expect(messages(form({ fields: [field({ help: "x".repeat(201) })] }))).toContain(BUILDER_COPY.helpLong);
    expect(messages(form({ fields: [field({ type: "number", unit: "x".repeat(13) })] }))).toContain(BUILDER_COPY.unitLong);
    expect(messages(form({ fields: [field({ type: "number", usualMin: "15", usualMax: "5" })] }))).toContain(BUILDER_COPY.range);
    expect(messages(form({ fields: [field({ type: "number", usualMin: "1e3" })] }))).toContain(BUILDER_COPY.rangeNumber);
    const opts = (labels: string[]) => labels.map((label) => ({ id: newOptionId(rnd), label }));
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A"]) })] }))).toContain(BUILDER_COPY.fewOptions);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(Array.from({ length: 13 }, (_, i) => `O${i}`)) })] }))).toContain(BUILDER_COPY.manyOptions);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A", ""]) })] }))).toContain(BUILDER_COPY.optionLabel);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A", "x".repeat(61)]) })] }))).toContain(BUILDER_COPY.optionLong);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["Clean", "clean"]) })] }))).toContain(BUILDER_COPY.optionDuplicate);
  });
  it("the 64 KB size rule", () => {
    const options = Array.from({ length: 12 }, (_, j) => ({ id: newOptionId(rnd), label: `${j}${"€".repeat(58)}` }));
    expect(messages(form({ fields: Array.from({ length: 30 }, () => field({ type: "choice", options })) }))).toContain(BUILDER_COPY.size);
  });
  it("errors show only for touched targets, all after a tap on the disabled Save", () => {
    const f = form({ name: "", fields: [field({ label: "" })] });
    const errs = builderErrors(f);
    expect(visibleErrors(errs, new Set(), false)).toEqual([]);
    expect(visibleErrors(errs, new Set(["form"]), false).map((e) => e.message)).toEqual([BUILDER_COPY.name]);
    expect(visibleErrors(errs, new Set(), true)).toHaveLength(2);
  });
});

describe("definition round trip", () => {
  it("archived job type ids are kept as they are", () => {
    const def = { name: "M", description: null, jobTypeIds: ["archived-jt"], required: false, fields: toDefinition(form()).fields };
    const b = fromDefinition(def);
    expect(b.appliesTo).toBe("some");
    expect(toDefinition(b).jobTypeIds).toEqual(["archived-jt"]);
    expect(toDefinition(b)).toEqual(def);
  });
});

describe("firstSaveOutcome (spec §4.1)", () => {
  it("201 → created at version 1; 200 → replay; no answer / 5xx / 429 → unknown (re-POST the same token)", () => {
    expect(firstSaveOutcome(201, { data: { id: "f1" } })).toEqual({ kind: "created", id: "f1", version: 1 });
    expect(firstSaveOutcome(200, { data: { id: "f1" } })).toEqual({ kind: "replay", id: "f1" });
    expect(firstSaveOutcome(null, null)).toEqual({ kind: "unknown" });
    expect(firstSaveOutcome(503, {})).toEqual({ kind: "unknown" });
    expect(firstSaveOutcome(409, { error: { code: "NAME_TAKEN" } })).toEqual({ kind: "refused", code: "NAME_TAKEN" });
  });
  it("a replay whose row differs from the builder stays dirty at the row's version", () => {
    const draft = toDefinition(form({ name: "Maintenance checklist v2" }));
    const row = { ...toDefinition(form()), version: 1 };
    expect(afterReplay(draft, { ...row, name: "Maintenance checklist" })).toEqual({ version: 1, dirty: true });
    expect(afterReplay(draft, { ...draft, version: 1 })).toEqual({ version: 1, dirty: false });
  });
});
