import { describe, it, expect } from "vitest";
import {
  addLine, checkDraft, nextOptionNames, optionFooter, parseDraft, removeLine, serializeDraft, setQuantity, startOptions,
  type DraftOption,
} from "./estimate-builder";

const names = (o: readonly DraftOption[]) => o.map((x) => x.name);
const line = (key: string, qty = 1) => ({ key, pricebookItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Capacitor", unitPriceCents: 12_500, quantity: qty });

describe("nextOptionNames (spec §7.1)", () => {
  it("starts with Option 1", () => expect(names(startOptions("a"))).toEqual(["Option 1"]));
  it("add with nothing edited renames by position: two → Good, Better; three → Good, Better, Best", () => {
    const two = nextOptionNames(startOptions("a"), { type: "add", key: "b" });
    expect(names(two)).toEqual(["Good", "Better"]);
    expect(names(nextOptionNames(two, { type: "add", key: "c" }))).toEqual(["Good", "Better", "Best"]);
  });
  it("add with an edited option keeps names and calls the new one Option N", () => {
    const edited = nextOptionNames(nextOptionNames(startOptions("a"), { type: "add", key: "b" }), { type: "rename", key: "a", name: "Repair" });
    expect(names(nextOptionNames(edited, { type: "add", key: "c" }))).toEqual(["Repair", "Better", "Option 3"]);
  });
  it("never more than three", () => {
    let o = startOptions("a");
    for (const k of ["b", "c", "d"]) o = nextOptionNames(o, { type: "add", key: k });
    expect(o).toHaveLength(3);
  });
  it("remove with nothing edited renames by position; one left → Option 1", () => {
    let o = startOptions("a");
    o = nextOptionNames(nextOptionNames(o, { type: "add", key: "b" }), { type: "add", key: "c" });
    o = nextOptionNames(o, { type: "remove", key: "a" });
    expect(names(o)).toEqual(["Good", "Better"]);
    expect(names(nextOptionNames(o, { type: "remove", key: "b" }))).toEqual(["Option 1"]);
  });
  it("remove keeps names when a remaining option is edited; the last option cannot be removed", () => {
    let o = nextOptionNames(nextOptionNames(startOptions("a"), { type: "add", key: "b" }), { type: "add", key: "c" });
    o = nextOptionNames(o, { type: "rename", key: "c", name: "Premium" });
    expect(names(nextOptionNames(o, { type: "remove", key: "a" }))).toEqual(["Better", "Premium"]);
    expect(nextOptionNames(startOptions("a"), { type: "remove", key: "a" })).toHaveLength(1);
  });
  it("rename marks edited", () => expect(nextOptionNames(startOptions("a"), { type: "rename", key: "a", name: "X" })[0]!.edited).toBe(true));
});

describe("lines and totals", () => {
  it("add, quantity 1–999, remove", () => {
    let o = addLine(startOptions("a"), "a", line("l1"));
    o = setQuantity(o, "a", "l1", 1200);
    expect(o[0]!.lines[0]!.quantity).toBe(999);
    o = setQuantity(o, "a", "l1", 0);
    expect(o[0]!.lines[0]!.quantity).toBe(1);
    expect(removeLine(o, "a", "l1")[0]!.lines).toEqual([]);
  });
  it("footer: Subtotal · Tax · Total from taxBps", () => {
    expect(optionFooter([line("l1", 2)], 825)).toBe("Subtotal $250.00 · Tax $20.63 · Total $270.63");
    expect(optionFooter([], 825)).toBe("Subtotal $0.00 · Tax $0.00 · Total $0.00");
  });
});

describe("checkDraft (spec §7.1 inline reasons)", () => {
  const two = (a: DraftOption["lines"], b: DraftOption["lines"]) =>
    [{ key: "a", name: "Good", edited: false, lines: a }, { key: "b", name: "Better", edited: false, lines: b }];
  it("names the option that needs an item", () => expect(checkDraft(two([line("l1")], []))).toEqual({ ok: false, reason: "Better needs an item." }));
  it("refuses blank, duplicate and long names", () => {
    expect(checkDraft([{ key: "a", name: " ", edited: true, lines: [line("l1")] }])).toEqual({ ok: false, reason: "Name every option." });
    expect(checkDraft([{ key: "a", name: "Good", edited: true, lines: [line("l1")] }, { key: "b", name: "good ", edited: true, lines: [line("l2")] }]))
      .toEqual({ ok: false, reason: "Two options have the same name." });
    expect(checkDraft([{ key: "a", name: "x".repeat(41), edited: true, lines: [line("l1")] }])).toEqual({ ok: false, reason: "Keep option names to 40 characters." });
  });
  it("refuses more than 40 items in an option", () => {
    const many = Array.from({ length: 41 }, (_, i) => line(`l${i}`));
    expect(checkDraft([{ key: "a", name: "Good", edited: false, lines: many }])).toEqual({ ok: false, reason: "Good has more than 40 items." });
  });
  it("builds the POST body with trimmed names", () => {
    expect(checkDraft(two([line("l1", 2)], [line("l2")]))).toEqual({ ok: true, body: { options: [
      { name: "Good", lines: [{ pricebookItemId: line("x").pricebookItemId, quantity: 2 }] },
      { name: "Better", lines: [{ pricebookItemId: line("x").pricebookItemId, quantity: 1 }] },
    ] } });
  });
});

describe("draft persistence", () => {
  it("round-trips", () => {
    const o = addLine(startOptions("a"), "a", line("l1", 3));
    expect(parseDraft(serializeDraft(o))).toEqual(o);
  });
  it("parseDraft ignores a corrupted or oversized draft", () => {
    for (const raw of [null, "", "{", "[]", JSON.stringify({ v: 2, options: [] }), JSON.stringify({ v: 1, options: [] }),
      JSON.stringify({ v: 1, options: Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, name: "x", edited: false, lines: [] })) }),
      JSON.stringify({ v: 1, options: [{ key: "a", name: "x", edited: false, lines: [{ key: "l", pricebookItemId: "p", name: "n", unitPriceCents: -1, quantity: 1 }] }] }),
      JSON.stringify({ v: 1, options: [{ key: "a", name: "x", edited: false, lines: [{ key: "l", pricebookItemId: "p", name: "n", unitPriceCents: 1, quantity: 1000 }] }] }),
    ]) expect(parseDraft(raw)).toBeNull();
  });
});
