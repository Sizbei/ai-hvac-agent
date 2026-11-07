import { describe, it, expect } from "vitest";
import type { FormField } from "@/lib/forms/form-schema";
import type { Changes } from "@/lib/forms/form-values";
import {
  afterLanded, answersHidden, buildChanges, carryForNewVersion, clearAllChanges, documentFromInputs, inputsFromValues, leaveBases,
  leaveMarkPending, leaveOutcome, LEAVE_MARK_MS, mergeIntoInputs, nextLastValid, parseInput, reconcileTransition, submitBlock, toggleSign,
  unparsedIds, unsavedChanges, type FillSnapshot,
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
    const r = mergeIntoInputs(FIELDS, {}, { [TEXT.id]: "mine" }, { [TICK.id]: true, [TEXT.id]: "theirs" }, { [TEXT.id]: "mine", [TICK.id]: false }, new Set([TEXT.id]), {});
    expect(r.inputs[TICK.id]).toBe(true);
    expect(r.inputs[TEXT.id]).toBe("mine");
    expect(r.foreignChange).toBe(true);
  });
  it("a merged-in number reseeds lastValid: 12 saved, their 15 merged, then my '15.' sends 15", () => {
    const r = mergeIntoInputs(FIELDS, { [NUM.id]: 12 }, {}, { [NUM.id]: 15 }, { [NUM.id]: "12" }, new Set(), { [NUM.id]: 12 });
    expect(r.inputs[NUM.id]).toBe("15");
    expect(r.lastValid).toEqual({ [NUM.id]: 15 });
    const lv = nextLastValid(r.lastValid, NUM, "15.");
    expect(buildChanges(FIELDS, { [NUM.id]: "15." }, new Set([NUM.id]), lv)).toEqual({ [NUM.id]: 15 });
    const gone = mergeIntoInputs(FIELDS, { [NUM.id]: 12 }, {}, {}, { [NUM.id]: "12" }, new Set(), { [NUM.id]: 12 });
    expect(gone.lastValid).toEqual({});
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

describe("reconcileTransition (the page's re-read merge, C I-1)", () => {
  const snap = (over: Partial<FillSnapshot>): FillSnapshot => ({
    fields: FIELDS, version: 1, base: {}, inputs: inputsFromValues(FIELDS, {}), touched: new Set(), lastValid: {}, ...over,
  });
  const row = (values: Record<string, unknown> | null, revision = 2, version = 1, fields = FIELDS) =>
    ({ form: { version, fields }, submission: { revision, values: values as never } });

  it("12 saved, their 15 merged, then '15.' sends 15: the page's lastValid is reseeded", () => {
    const s = snap({ base: { [NUM.id]: 12 }, inputs: inputsFromValues(FIELDS, { [NUM.id]: 12 }), lastValid: { [NUM.id]: 12 } });
    const r = reconcileTransition(s, {}, false, row({ [NUM.id]: 15 }, 4), "STALE");
    expect(r.inputs[NUM.id]).toBe("15");
    expect(r.lastValid).toEqual({ [NUM.id]: 15 });
    expect(r.base).toEqual({ [NUM.id]: 15 });
    expect(r.revision).toBe(4);
    expect(r.foreignChange).toBe(true);
    const lv = nextLastValid(r.lastValid, NUM, "15.");
    expect(buildChanges(r.fields, { ...r.inputs, [NUM.id]: "15." }, new Set([NUM.id]), lv)).toEqual({ [NUM.id]: 15 });
  });
  it("a live merge keeps every touched input, a half-typed number included, and mine over theirs", () => {
    const s = snap({ inputs: { ...inputsFromValues(FIELDS, {}), [NUM.id]: "1.", [TEXT.id]: "mine" }, touched: new Set([NUM.id, TEXT.id]) });
    const r = reconcileTransition(s, { [TEXT.id]: "mine" }, false, row({ [TEXT.id]: "theirs", [TICK.id]: true }), "STALE");
    expect(r.inputs[NUM.id]).toBe("1.");
    expect(r.inputs[TEXT.id]).toBe("mine");
    expect(r.inputs[TICK.id]).toBe(true);
    expect([...r.touched].sort()).toEqual([NUM.id, TEXT.id].sort());
    expect(r.formChanged).toBe(false);
  });
  it("FORM_CHANGED drops a field the new version can't take from touched and lists it", () => {
    const v2 = [TICK, TEXT];
    const s = snap({ inputs: { ...inputsFromValues(FIELDS, {}), [NUM.id]: "7", [TEXT.id]: "x" }, touched: new Set([NUM.id, TEXT.id]), lastValid: { [NUM.id]: 7 } });
    const r = reconcileTransition(s, { [NUM.id]: 7, [TEXT.id]: "x" }, false, row({}, 3, 2, v2), "FORM_CHANGED");
    expect(r.formChanged).toBe(true);
    expect(r.dropped).toEqual([NUM.id]);
    expect([...r.touched]).toEqual([TEXT.id]);
    expect(r.fields).toBe(v2);
    expect(r.version).toBe(2);
    expect(r.inputs[TEXT.id]).toBe("x");
  });
  it("a version moved without the code still carries", () => {
    const r = reconcileTransition(snap({}), {}, false, row({}, 1, 3, [TICK]), null);
    expect(r.formChanged).toBe(true);
    expect(r.fields).toEqual([TICK]);
  });
  it("a recovered submit rebuilds its inputs from its changes; only they are touched", () => {
    const s = snap({ inputs: { ...inputsFromValues(FIELDS, {}), [TEXT.id]: "live" }, touched: new Set([YN.id]) });
    const r = reconcileTransition(s, { [TEXT.id]: "sent", [TICK.id]: true }, true, row({ [YN.id]: "no" }), "STALE");
    expect(r.inputs[TEXT.id]).toBe("sent");
    expect(r.inputs[TICK.id]).toBe(true);
    expect(r.inputs[YN.id]).toBe("no");
    expect([...r.touched].sort()).toEqual([TEXT.id, TICK.id].sort());
  });
  it("no row: revision 0 and an empty base", () => {
    const r = reconcileTransition(snap({}), {}, false, { form: { version: 1, fields: FIELDS }, submission: null }, "STALE");
    expect(r.revision).toBe(0);
    expect(r.base).toEqual({});
  });
});

describe("leaving (ruling R1)", () => {
  it("leaveBases: each changed field's last-seen value, null when absent", () => {
    expect(leaveBases({ [TEXT.id]: "new", [TICK.id]: null }, { [TEXT.id]: "old", [NUM.id]: 3 })).toEqual({ [TEXT.id]: "old", [TICK.id]: null });
    expect(leaveBases({}, { [TEXT.id]: "old" })).toEqual({});
    expect(leaveBases({ toString: "x" }, {})).toEqual({ toString: null });
  });
  it("leaveOutcome: skipped fields don't land; a merge is a skip or a jump past this write", () => {
    const sent: Changes = { [TEXT.id]: "a", [TICK.id]: true };
    expect(leaveOutcome(sent, 3, 4, undefined)).toEqual({ merged: false, applied: sent });
    expect(leaveOutcome(sent, 3, 4, [])).toEqual({ merged: false, applied: sent });
    expect(leaveOutcome(sent, 3, 6, [])).toEqual({ merged: true, applied: sent });
    expect(leaveOutcome(sent, 3, 6, [TEXT.id, 5])).toEqual({ merged: true, applied: { [TICK.id]: true } });
  });
  it("unsavedChanges: what the base doesn't hold yet (null = absent)", () => {
    expect(unsavedChanges({ [NUM.id]: 12, [TEXT.id]: null, [TICK.id]: true }, { [NUM.id]: 12 })).toEqual({ [TICK.id]: true });
    expect(unsavedChanges({ [NUM.id]: null }, { [NUM.id]: 12 })).toEqual({ [NUM.id]: null });
  });
  it("leaveMarkPending: recent, readable, and the loaded row doesn't hold the sent changes yet", () => {
    const mark = JSON.stringify({ at: 1000, changes: { [TEXT.id]: "R-final", [NUM.id]: null } });
    // A colleague's save moved the revision, but the row still has my old answer: wait.
    expect(leaveMarkPending(mark, 2000, { [TEXT.id]: "B-final", [YN.id]: "no" })).toBe(true);
    expect(leaveMarkPending(mark, 2000, { [TEXT.id]: "R-final", [YN.id]: "no" })).toBe(false);
    expect(leaveMarkPending(mark, 2000, { [TEXT.id]: "R-final", [NUM.id]: 4 })).toBe(true);
    expect(leaveMarkPending(mark, 1000 + LEAVE_MARK_MS, {})).toBe(false);
    expect(leaveMarkPending(null, 2000, {})).toBe(false);
    expect(leaveMarkPending("{", 2000, {})).toBe(false);
    expect(leaveMarkPending(JSON.stringify({ at: 1000, changes: [1] }), 2000, {})).toBe(false);
  });
  it("answersHidden: erased or unreadable rows show no values; an empty draft still does", () => {
    expect(answersHidden({ erased: true, values: null })).toBe(true);
    expect(answersHidden({ erased: false, values: null })).toBe(true);
    expect(answersHidden({ erased: false, values: {} })).toBe(false);
    expect(answersHidden(null)).toBe(false);
  });
});
