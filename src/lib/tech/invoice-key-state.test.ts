import { describe, it, expect } from "vitest";
import { nextKeyState, outcomeEvent, type KeyState, type KeyEvent, type WriteOutcome } from "./invoice-key-state";

function minter(...keys: string[]): () => string {
  const queue = [...keys];
  return () => {
    const k = queue.shift();
    if (!k) throw new Error("mint called more times than expected");
    return k;
  };
}

const IDLE: KeyState = { phase: "idle" };
const ARMED: KeyState = { phase: "armed", key: "k1", bodyHash: "h1", body: { amount: 100 } };
const SENT: KeyState = { ...ARMED, phase: "sent" };
const UNKNOWN: KeyState = { ...ARMED, phase: "unknown" };

const open = (bodyHash: string, mint = minter("k2")): KeyEvent => ({ type: "open", bodyHash, body: { amount: 200 }, mint });
const edit = (bodyHash: string, mint = minter("k2")): KeyEvent => ({ type: "edit", bodyHash, body: { amount: 200 }, mint });

describe("nextKeyState", () => {
  it("idle + open arms with a newly minted key and the body", () => {
    expect(nextKeyState(IDLE, open("h2"))).toEqual({ phase: "armed", key: "k2", bodyHash: "h2", body: { amount: 200 } });
  });

  it("armed + open is unchanged and mints nothing", () => {
    expect(nextKeyState(ARMED, open("h2", minter()))).toBe(ARMED);
  });

  it("armed + edit with a different body mints a NEW key and takes the new body", () => {
    expect(nextKeyState(ARMED, edit("h2"))).toEqual({ phase: "armed", key: "k2", bodyHash: "h2", body: { amount: 200 } });
  });

  it("armed + edit with the same body hash is a no-op", () => {
    expect(nextKeyState(ARMED, edit("h1", minter()))).toBe(ARMED);
  });

  it("idle + edit is unchanged (an intent arms on open)", () => {
    expect(nextKeyState(IDLE, edit("h2", minter()))).toBe(IDLE);
  });

  it.each([
    ["sent", SENT],
    ["unknown", UNKNOWN],
  ] as const)("%s + edit/open is UNCHANGED (inputs are read-only while in flight)", (_name, s) => {
    expect(nextKeyState(s, edit("h2", minter()))).toBe(s);
    expect(nextKeyState(s, open("h2", minter()))).toBe(s);
  });

  it("armed + sent → sent with the same key and body", () => {
    expect(nextKeyState(ARMED, { type: "sent" })).toEqual(SENT);
  });

  it("unknown + sent → sent (the re-send of the OLD body)", () => {
    expect(nextKeyState(UNKNOWN, { type: "sent" })).toEqual(SENT);
  });

  it("idle + sent is unchanged", () => {
    expect(nextKeyState(IDLE, { type: "sent" })).toBe(IDLE);
  });

  it("sent + spent → idle", () => {
    expect(nextKeyState(SENT, { type: "spent" })).toEqual(IDLE);
  });

  it("sent + unknown → unknown with the same key and body", () => {
    expect(nextKeyState(SENT, { type: "unknown" })).toEqual(UNKNOWN);
  });

  it("definitive_unstored → armed with the SAME key and body", () => {
    expect(nextKeyState(SENT, { type: "definitive_unstored" })).toEqual(ARMED);
    expect(nextKeyState(UNKNOWN, { type: "definitive_unstored" })).toEqual(ARMED);
  });

  it.each([["armed", ARMED], ["sent", SENT], ["unknown", UNKNOWN], ["idle", IDLE]] as const)(
    "%s + dropped → idle",
    (_name, s) => {
      expect(nextKeyState(s, { type: "dropped" })).toEqual(IDLE);
    },
  );

  it("never mutates the input state", () => {
    const s: KeyState = Object.freeze({ ...ARMED });
    nextKeyState(s, edit("h2"));
    nextKeyState(s, { type: "sent" });
    expect(s).toEqual(ARMED);
  });
});

describe("outcomeEvent", () => {
  it.each<[WriteOutcome, KeyEvent["type"]]>([
    ["success_refetch", "spent"],
    ["already_saved_refetch", "spent"],
    ["spent_new_key", "spent"],
    ["refetch_new_key", "spent"],
  ])("%s → %s regardless of the refetch", (o, ev) => {
    expect(outcomeEvent(o, false)).toBe(ev);
    expect(outcomeEvent(o, true)).toBe(ev);
  });

  it.each<[WriteOutcome, KeyEvent["type"], KeyEvent["type"]]>([
    ["retry_same_key_after_refetch", "dropped", "unknown"],
    ["wait_then_refetch", "dropped", "unknown"],
    ["show_message_refetch", "dropped", "definitive_unstored"],
  ])("%s → %s when the state advanced, else %s", (o, advanced, notAdvanced) => {
    expect(outcomeEvent(o, true)).toBe(advanced);
    expect(outcomeEvent(o, false)).toBe(notAdvanced);
  });
});
