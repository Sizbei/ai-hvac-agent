import { describe, it, expect } from "vitest";
import { serializeIntents, parseIntents, persistOps, INTENTS_STORAGE_KEY } from "./invoice-intent-persist";
import type { KeyState } from "./invoice-key-state";

const IDLE: KeyState = { phase: "idle" };
const ARMED: KeyState = { phase: "armed", key: "k1", bodyHash: "h1", body: { amountCents: 100 } };
const SENT: KeyState = { ...ARMED, phase: "sent" };
const UNKNOWN: KeyState = { phase: "unknown", key: "k2", bodyHash: "h2", body: { lines: [1, 2] } };

describe("serializeIntents", () => {
  it("omits idle and armed intents", () => {
    expect(JSON.parse(serializeIntents({ a: IDLE, b: ARMED }))).toEqual({});
  });

  it("round-trips unknown intents and rehydrates sent as unknown", () => {
    const parsed = parseIntents(serializeIntents({ pay: SENT, line: UNKNOWN, idle: IDLE }));
    expect(parsed).toEqual({ pay: { ...SENT, phase: "unknown" }, line: UNKNOWN });
  });
});

describe("parseIntents", () => {
  it.each([null, "", "not json", "[]", "42", "null", '"str"'])("malformed %j → {}", (raw) => {
    expect(parseIntents(raw)).toEqual({});
  });

  it("maps a persisted sent to unknown", () => {
    const raw = JSON.stringify({ pay: { phase: "sent", key: "k", bodyHash: "h", body: 1 } });
    expect(parseIntents(raw)).toEqual({ pay: { phase: "unknown", key: "k", bodyHash: "h", body: 1 } });
  });

  it("skips entries with a bad shape or a non-persisted phase", () => {
    const raw = JSON.stringify({
      ok: { phase: "unknown", key: "k", bodyHash: "h", body: null },
      armed: { phase: "armed", key: "k", bodyHash: "h", body: 1 },
      noKey: { phase: "unknown", bodyHash: "h", body: 1 },
      noBody: { phase: "unknown", key: "k", bodyHash: "h" },
      notObj: 5,
    });
    expect(parseIntents(raw)).toEqual({ ok: { phase: "unknown", key: "k", bodyHash: "h", body: null } });
  });
});

describe("persistOps", () => {
  it.each<[string, KeyState, KeyState, "write" | "clear" | "none"]>([
    ["armed → sent", ARMED, SENT, "write"],
    ["sent → unknown", SENT, UNKNOWN, "write"],
    ["unknown → sent", UNKNOWN, SENT, "write"],
    ["sent → idle (spent)", SENT, IDLE, "clear"],
    ["unknown → idle (dropped)", UNKNOWN, IDLE, "clear"],
    ["sent → armed (definitive_unstored)", SENT, ARMED, "clear"],
    ["unknown → armed", UNKNOWN, ARMED, "clear"],
    ["idle → armed", IDLE, ARMED, "none"],
    ["armed → armed", ARMED, { ...ARMED, key: "k9" }, "none"],
    ["armed → idle", ARMED, IDLE, "none"],
    ["idle → idle", IDLE, IDLE, "none"],
  ])("%s → %s", (_name, prev, next, op) => {
    expect(persistOps(prev, next)).toBe(op);
  });
});

describe("INTENTS_STORAGE_KEY", () => {
  it("is per request", () => {
    expect(INTENTS_STORAGE_KEY("r-1")).toBe("tech:invoice:r-1:intents");
  });
});
