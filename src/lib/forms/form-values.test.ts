import { describe, it, expect } from "vitest";
import { FORM_LIMITS, formFieldsSchema, type FormField } from "./form-schema";
import {
  answerText, applyChanges, carryValues, draftValueOk, droppedByCarry, hasControlChars, mergeDraft, missingRequired,
  numberInputState, rangeNote, stripControlChars, valuesBytes, valuesTooLarge,
} from "./form-values";

const F = {
  tick: { id: "f_0000000001", type: "checkbox", label: "Filter changed", required: true },
  yn: { id: "f_0000000002", type: "yes_no", label: "Coil clean?", required: true, allowNa: true },
  ynNoNa: { id: "f_0000000003", type: "yes_no", label: "Drain clear?", required: false },
  short: { id: "f_0000000004", type: "short_text", label: "Filter size", required: false },
  long: { id: "f_0000000005", type: "long_text", label: "Findings", required: false },
  num: { id: "f_0000000006", type: "number", label: "Suction", required: true, unit: "psi", usualMin: 100, usualMax: 140 },
  choice: { id: "f_0000000007", type: "choice", label: "Filter", required: false, options: [{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "Dirty" }] },
  head: { id: "f_0000000008", type: "heading", label: "Outdoor unit", required: false },
} as const satisfies Record<string, FormField>;
const FIELDS: FormField[] = Object.values(F);

describe("draftValueOk (spec §3.3)", () => {
  it("accepts each type's value and null as cleared; refuses headings", () => {
    expect(draftValueOk(F.tick, true)).toBe(true);
    expect(draftValueOk(F.tick, false)).toBe(false);
    expect(draftValueOk(F.yn, "na")).toBe(true);
    expect(draftValueOk(F.ynNoNa, "na")).toBe(false);
    expect(draftValueOk(F.short, "16x25x1")).toBe(true);
    expect(draftValueOk(F.short, "x".repeat(201))).toBe(false);
    expect(draftValueOk(F.long, "x".repeat(2000))).toBe(true);
    expect(draftValueOk(F.num, 118.25)).toBe(true);
    expect(draftValueOk(F.num, 12.3456)).toBe(false);
    expect(draftValueOk(F.choice, "o_aaaaaaaa")).toBe(true);
    expect(draftValueOk(F.choice, "o_cccccccc")).toBe(false);
    expect(draftValueOk(F.short, null)).toBe(true);
    expect(draftValueOk(F.head, null)).toBe(false);
  });

  it("refuses C0 controls other than tab, LF and CR; the client strips them", () => {
    expect(draftValueOk(F.long, "line 1\nline 2\tx\r")).toBe(true);
    expect(draftValueOk(F.short, "bell\u0007")).toBe(false);
    expect(hasControlChars("a\u0000b")).toBe(true);
    expect(stripControlChars("a\u0000b\u001Fc\n")).toBe("abc\n");
  });

  it("does not range-check: an outside reading is a valid draft", () => {
    expect(draftValueOk(F.num, 300)).toBe(true);
  });
});

describe("applyChanges", () => {
  it("sets, clears and keeps untouched answers; never mutates the input", () => {
    const doc = Object.freeze({ [F.tick.id]: true, [F.short.id]: "16x25" });
    const r = applyChanges(FIELDS, doc, { [F.short.id]: null, [F.num.id]: 118 });
    expect(r).toEqual({ ok: true, values: { [F.tick.id]: true, [F.num.id]: 118 } });
    expect(doc).toEqual({ [F.tick.id]: true, [F.short.id]: "16x25" });
  });

  it("refuses unknown keys, heading keys and bad values with their ids", () => {
    expect(applyChanges(FIELDS, {}, { f_9999999999: true, [F.head.id]: "x", [F.num.id]: "12" })).toEqual({
      ok: false, fieldIds: ["f_9999999999", F.head.id, F.num.id],
    });
  });
});

describe("the 128 KB measure", () => {
  it("counts UTF-8 bytes of JSON.stringify, so multibyte and emoji weigh more than their length", () => {
    expect(valuesBytes({ a: "é" })).toBe(JSON.stringify({ a: "x" }).length + 1);
    expect(valuesBytes({ a: "😀" })).toBe(JSON.stringify({ a: "x" }).length + 3);
    // A tab is escaped by JSON.stringify: {"a":"\t"} is 10 bytes.
    expect(valuesBytes({ a: "\t" })).toBe(10);
  });

  it("the cap is unreachable with a valid definition: the largest valid document is measured well under it", () => {
    // 10 long answers (the most a form may hold) + 50 short answers, every one at its length limit in "€"
    // (3 UTF-8 bytes per UTF-16 unit, the worst a valid text can do; JSON escapes cost at most 2).
    const fields: FormField[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `f_long${String(i).padStart(6, "0")}`, type: "long_text" as const, label: "L", required: false })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `f_shrt${String(i).padStart(6, "0")}`, type: "short_text" as const, label: "S", required: false })),
    ];
    expect(formFieldsSchema.safeParse(fields).success).toBe(true);
    const values = Object.fromEntries(fields.map((f) => [f.id, "€".repeat(f.type === "long_text" ? FORM_LIMITS.longText : FORM_LIMITS.shortText)]));
    expect(fields.every((f) => draftValueOk(f, values[f.id]))).toBe(true);
    expect(valuesBytes(values)).toBe(91_081);
    expect(valuesTooLarge(values)).toBe(false);
  });

  it("refuses just over the cap and accepts at it", () => {
    const pad = (n: number) => ({ a: "x".repeat(n) });
    const overhead = valuesBytes(pad(0));
    expect(valuesTooLarge(pad(128 * 1024 - overhead))).toBe(false);
    expect(valuesTooLarge(pad(128 * 1024 - overhead + 1))).toBe(true);
    expect(valuesTooLarge({ a: "€".repeat(44_000) })).toBe(true);
  });
});

describe("missingRequired", () => {
  it("an unticked checkbox and an absent number are missing; N/A satisfies", () => {
    expect(missingRequired(FIELDS, { [F.yn.id]: "na" })).toEqual([F.tick.id, F.num.id]);
    expect(missingRequired(FIELDS, { [F.tick.id]: true, [F.yn.id]: "no", [F.num.id]: 300 })).toEqual([]);
  });
});

describe("carryValues", () => {
  it("drops answers whose field or option is gone, keeps the rest", () => {
    const v2: FormField[] = [F.tick, { ...F.choice, options: [{ id: "o_bbbbbbbb", label: "Dirty" }, { id: "o_cccccccc", label: "Missing" }] }];
    const before = { [F.tick.id]: true, [F.choice.id]: "o_aaaaaaaa", [F.short.id]: "16x25" } as const;
    const after = carryValues(v2, before);
    expect(after).toEqual({ [F.tick.id]: true });
    expect(droppedByCarry(before, after)).toEqual([F.choice.id, F.short.id]);
  });
});

describe("mergeDraft (spec §7.3)", () => {
  it("touched fields win, others take theirs; banner only for a foreign change", () => {
    const base = { a: true, b: "x" } as const;
    const theirs = { a: true, b: "y", c: 5 } as const;
    expect(mergeDraft(base, { a: null }, theirs)).toEqual({ values: { b: "y", c: 5 }, foreignChange: true });
  });

  it("a retry of my own landed write finds no foreign change", () => {
    const base = { a: true } as const;
    expect(mergeDraft(base, { b: "mine" }, { a: true, b: "mine" })).toEqual({ values: { a: true, b: "mine" }, foreignChange: false });
  });

  it("FORM_CHANGED path: carry both sides, then merge, so a colleague's answers survive", () => {
    const v2: FormField[] = [F.tick, F.short];
    const base = carryValues(v2, {});
    const mine = carryValues(v2, { [F.short.id]: "16x25", [F.num.id]: 118 });
    const theirs = { [F.tick.id]: true } as const;
    const m = mergeDraft(base, mine as Record<string, string>, theirs);
    expect(m.values).toEqual({ [F.tick.id]: true, [F.short.id]: "16x25" });
    expect(m.foreignChange).toBe(true);
  });
});

describe("numberInputState", () => {
  it("parses plain and thousands-separated numbers", () => {
    expect(numberInputState("1,200")).toEqual({ kind: "value", value: 1200 });
    expect(numberInputState(" 12.5 ")).toEqual({ kind: "value", value: 12.5 });
    expect(numberInputState("-0")).toEqual({ kind: "value", value: 0 });
    expect(numberInputState(".5")).toEqual({ kind: "value", value: 0.5 });
  });
  it("partial prefixes", () => {
    for (const s of ["-", "12.", "-.", "1,", "1,2", "1,20", "12,345,"]) expect(numberInputState(s)).toEqual({ kind: "partial" });
  });
  it("invalid and out of bounds", () => {
    for (const s of ["1e3", "12.3456", "abc", "1,2345", "--1"]) expect(numberInputState(s)).toEqual({ kind: "invalid" });
    expect(numberInputState("2000000")).toEqual({ kind: "out_of_bounds" });
    expect(numberInputState("")).toEqual({ kind: "empty" });
  });
});

describe("answerText and rangeNote", () => {
  it("renders every type", () => {
    expect(answerText(F.tick, true)).toBe("Done");
    expect(answerText(F.tick, undefined)).toBe("Not done");
    expect(answerText(F.yn, "na")).toBe("N/A");
    expect(answerText(F.choice, "o_bbbbbbbb")).toBe("Dirty");
    expect(answerText(F.num, 118)).toBe("118 psi");
    expect(answerText(F.num, 1200.5)).toBe("1,200.5 psi · Outside the usual range (100–140 psi)");
    expect(answerText(F.short, undefined)).toBe("No answer");
    expect(answerText(F.head, undefined)).toBe("Outdoor unit");
  });
  it("one-bound and unit-less ranges", () => {
    const lo: FormField = { id: "f_0000000009", type: "number", label: "T", required: false, unit: "°F", usualMin: 5 };
    const hi: FormField = { id: "f_0000000010", type: "number", label: "T", required: false, unit: "°F", usualMax: 15 };
    const bare: FormField = { id: "f_0000000011", type: "number", label: "T", required: false, usualMin: 5, usualMax: 15 };
    expect(rangeNote(lo, 2)).toBe("Outside the usual range (at least 5 °F)");
    expect(rangeNote(hi, 20)).toBe("Outside the usual range (at most 15 °F)");
    expect(rangeNote(bare, 20)).toBe("Outside the usual range (5–15)");
    expect(rangeNote(bare, 10)).toBeNull();
  });
});
