import { describe, it, expect } from "vitest";
import type { FormField } from "@/lib/forms/form-schema";
import {
  afterLanded, buildChanges, carryForNewVersion, clearAllChanges, documentFromInputs, inputsFromValues, mergeIntoInputs, nextLastValid,
  parseInput, submitBlock, toggleSign, unparsedIds,
} from "./form-fill-state";

const TICK: FormField = { id: "f_0000000001", type: "checkbox", label: "Filter", required: true };
const NUM: FormField = { id: "f_0000000002", type: "number", label: "Suction", required: true, unit: "psi" };
const TEXT: FormField = { id: "f_0000000003", type: "short_text", label: "Size", required: false };
const YN: FormField = { id: "f_0000000004", type: "yes_no", label: "Clean?", required: false, allowNa: true };
const FIELDS = [TICK, NUM, TEXT, YN];

describe("inputs ↔ values", () => {
  it("round-trips each type; parseInput strips controls and reads empty as null", () => {
    const inputs = inputsFromValues(FIELDS, { [TICK.id]: true, [NUM.id]: 118, [YN.id]: "na" });
    expect(inputs).toEqual({ [TICK.id]: true, [NUM.id]: "118", [TEXT.id]: "", [YN.id]: "na" });
    expect(parseInput(TEXT, "a\u0007b")).toEqual({ kind: "value", value: "ab" });
    expect(parseInput(NUM, "12.")).toEqual({ kind: "unparsed" });
    expect(parseInput(NUM, "")).toEqual({ kind: "value", value: null });
    expect(documentFromInputs(FIELDS, inputs, {})).toEqual({ [TICK.id]: true, [NUM.id]: 118, [YN.id]: "na" });
  });
});

describe("the changes builder (spec §7.3)", () => {
  it('"12" landed, then "12." → the body still sends 12, never a deletion', () => {
    let lastValid = nextLastValid({}, NUM, "12");
    lastValid = nextLastValid(lastValid, NUM, "12.");
    expect(buildChanges(FIELDS, { [NUM.id]: "12." }, new Set([NUM.id]), lastValid)).toEqual({ [NUM.id]: 12 });
    expect(unparsedIds(FIELDS, { [NUM.id]: "12." })).toEqual([NUM.id]);
  });
  it("emptied → null; a never-valid partial is not sent; untouched fields are not sent", () => {
    expect(buildChanges(FIELDS, { [TEXT.id]: "", [NUM.id]: "-" }, new Set([TEXT.id, NUM.id]), {})).toEqual({ [TEXT.id]: null });
    expect(buildChanges(FIELDS, { [TICK.id]: true }, new Set(), {})).toEqual({});
  });
  it("an edit during the flight survives the landing", () => {
    const sent = { [TEXT.id]: "16x25" };
    const now = { [TEXT.id]: "16x25x1", [TICK.id]: true };
    const r = afterLanded(FIELDS, {}, sent, now, new Set([TEXT.id, TICK.id]));
    expect(r.base).toEqual({ [TEXT.id]: "16x25" });
    expect([...r.touched].sort()).toEqual([TEXT.id, TICK.id].sort());
    const done = afterLanded(FIELDS, {}, sent, { [TEXT.id]: "16x25" }, new Set([TEXT.id]));
    expect([...done.touched]).toEqual([]);
  });
  it("a tick whose response was lost, then an untick: the second body clears it", () => {
    const touched = new Set([TICK.id]);
    expect(buildChanges(FIELDS, { [TICK.id]: true }, touched, {})).toEqual({ [TICK.id]: true });
    expect(buildChanges(FIELDS, { [TICK.id]: false }, touched, {})).toEqual({ [TICK.id]: null });
  });
});

describe("merge and carry", () => {
  it("untouched inputs follow theirs; touched keep mine; banner only for a foreign change", () => {
    const r = mergeIntoInputs(FIELDS, {}, { [TEXT.id]: "mine" }, { [TICK.id]: true, [TEXT.id]: "theirs" }, { [TEXT.id]: "mine", [TICK.id]: false }, new Set([TEXT.id]));
    expect(r.inputs[TICK.id]).toBe(true);
    expect(r.inputs[TEXT.id]).toBe("mine");
    expect(r.foreignChange).toBe(true);
  });
  it("carry drops answers that no longer fit and lists them", () => {
    const v2: FormField[] = [TICK, { ...YN, allowNa: false }];
    expect(carryForNewVersion(v2, { [NUM.id]: 5 }, { [YN.id]: "na", [TICK.id]: true, [TEXT.id]: null })).toEqual({
      base: {}, mine: { [TICK.id]: true }, dropped: [YN.id, TEXT.id],
    });
  });
});

describe("submit checks", () => {
  it("unparsed numbers first, then missing required", () => {
    expect(submitBlock(FIELDS, { [NUM.id]: "1," })).toEqual({ kind: "unparsed", fieldIds: [NUM.id] });
    expect(submitBlock(FIELDS, { [NUM.id]: "300" })).toEqual({ kind: "missing", fieldIds: [TICK.id] });
    expect(submitBlock(FIELDS, { [NUM.id]: "300", [TICK.id]: true })).toBeNull();
  });
  it("Clear answers sends every answered field as null", () => {
    expect(clearAllChanges({ [TICK.id]: true, [NUM.id]: 5 })).toEqual({ [TICK.id]: null, [NUM.id]: null });
  });
});

describe("toggleSign", () => {
  it("empty → '-', toggles a leading minus", () => {
    expect(toggleSign("")).toBe("-");
    expect(toggleSign("12")).toBe("-12");
    expect(toggleSign("-12")).toBe("12");
  });
});
