import { describe, it, expect } from "vitest";
import { formDefinitionSchema, formFieldsSchema, firstIssuePath, isFormNumber, parseStoredFields, questionCount, utf8Bytes, type FormField } from "./form-schema";

const id = (n: number) => `f_${String(n).padStart(10, "0")}`;
const cb = (n: number, over: Partial<FormField> = {}) => ({ id: id(n), type: "checkbox", label: `Item ${n}`, required: false, ...over });
const def = (fields: unknown[]) => ({ name: "Maintenance checklist", description: null, jobTypeIds: [], required: false, fields });
const pathOf = (fields: unknown[]) => {
  const r = formFieldsSchema.safeParse(fields);
  return r.success ? null : firstIssuePath(r.error);
};

describe("formDefinitionSchema (spec §3.3)", () => {
  it("accepts every field type with its extras and trims the name", () => {
    const r = formDefinitionSchema.safeParse({
      ...def([
        { id: id(1), type: "heading", label: "Outdoor unit", required: false },
        cb(2, { required: true }),
        { id: id(3), type: "yes_no", label: "Coil clean?", required: true, allowNa: true },
        { id: id(4), type: "short_text", label: "Filter size", required: false, help: "e.g. 16x25x1" },
        { id: id(5), type: "long_text", label: "Findings", required: false },
        { id: id(6), type: "number", label: "Suction", required: true, unit: "psi", usualMin: 100, usualMax: 140 },
        { id: id(7), type: "choice", label: "Filter", required: false, options: [{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "Dirty" }] },
      ]),
      name: "  Maintenance checklist  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Maintenance checklist");
  });

  it("refuses a form with only headings, more than 60 fields, more than 10 long answers", () => {
    expect(pathOf([{ id: id(1), type: "heading", label: "H", required: false }])).toEqual([]);
    expect(pathOf(Array.from({ length: 61 }, (_, i) => cb(i)))).toEqual([]);
    // The array itself is bounded (.max), not only the refinement.
    expect(formFieldsSchema.safeParse(Array.from({ length: 61 }, (_, i) => cb(i))).error?.issues.some((i) => i.code === "too_big")).toBe(true);
    expect(pathOf(Array.from({ length: 11 }, (_, i) => ({ id: id(i), type: "long_text", label: "L", required: false })))).toEqual([]);
    expect(pathOf([])).toEqual([]);
  });

  it("refuses a required heading, duplicate field ids, bad ids", () => {
    expect(pathOf([cb(1), { id: id(2), type: "heading", label: "H", required: true }])).toEqual([1, "required"]);
    expect(pathOf([cb(1), cb(1)])).toEqual([1, "id"]);
    expect(pathOf([{ ...cb(1), id: "f_SHORT" }])).toEqual([0, "id"]);
  });

  it("choice: 2–12 options, option ids o_ + 8, labels unique case-insensitively", () => {
    const ch = (options: unknown[]) => [{ id: id(1), type: "choice", label: "C", required: false, options }];
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "A" }]))).toEqual([0, "options"]);
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "clean" }]))).toEqual([0, "options"]);
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "A" }, { id: "o_x", label: "B" }]))).toEqual([0, "options", 1, "id"]);
  });

  it("number: unit ≤ 12, usual range low ≤ high, bounds and decimals", () => {
    const n = (over: object) => [{ id: id(1), type: "number", label: "N", required: false, ...over }];
    expect(pathOf(n({ unit: "x".repeat(13) }))).toEqual([0, "unit"]);
    expect(pathOf(n({ usualMin: 15, usualMax: 5 }))).toEqual([0, "usualMax"]);
    expect(pathOf(n({ usualMin: 1.2345 }))).toEqual([0, "usualMin"]);
    expect(pathOf(n({ usualMin: 5, usualMax: 5 }))).toBeNull();
  });

  it("a definition over 64 KB is refused", () => {
    const options = Array.from({ length: 12 }, (_, j) => ({ id: `o_${String(j).padStart(8, "0")}`, label: `${j}${"€".repeat(58)}` }));
    const big = Array.from({ length: 30 }, (_, i) => ({ id: id(i), type: "choice", label: "C", required: false, options }));
    expect(utf8Bytes(JSON.stringify(big))).toBeGreaterThan(64 * 1024);
    expect(pathOf(big)).toEqual([]);
  });

  it("isFormNumber, parseStoredFields, questionCount", () => {
    expect([12.5, -0.001, 999_999.999].every(isFormNumber)).toBe(true);
    expect([1_000_000, 1.2345, Number.NaN, Infinity, "1"].some(isFormNumber)).toBe(false);
    expect(parseStoredFields([{ nope: true }])).toBeNull();
    const fields = parseStoredFields([cb(1), { id: id(2), type: "heading", label: "H", required: false }])!;
    expect(questionCount(fields)).toBe(1);
  });
});
