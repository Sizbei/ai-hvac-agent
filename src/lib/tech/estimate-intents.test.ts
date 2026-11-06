import { describe, it, expect } from "vitest";
import {
  ESTIMATE_INTENT, ESTIMATE_INTENTS_KEY, estimateWriteCopy, isStoredWrite, recoveryKeeps, storedToRecover, withoutIntent,
} from "./estimate-intents";
import { INTENTS_STORAGE_KEY, serializeIntents } from "./invoice-intent-persist";

const write = (path: string) => ({ path, payload: { optionId: "o", signatureName: "Pat" } });
const raw = serializeIntents({
  "estimate:sell:e1": { phase: "sent", key: "k1", bodyHash: "h1", body: write("/api/tech/jobs/r/estimates/e1/sell") },
  "estimate:bill:e2": { phase: "unknown", key: "k2", bodyHash: "h2", body: write("/api/tech/jobs/r/estimates/e2/bill") },
  "equipment:add": { phase: "sent", key: "k3", bodyHash: "h3", body: { path: "https://evil.example/x", payload: {} } },
});

describe("estimate intents (spec §7)", () => {
  it("own storage key and intent ids", () => {
    expect(ESTIMATE_INTENTS_KEY("r")).toBe("tech:estimate:r:intents");
    expect(ESTIMATE_INTENTS_KEY("r")).not.toBe(INTENTS_STORAGE_KEY("r"));
    expect([ESTIMATE_INTENT.create, ESTIMATE_INTENT.sell("e"), ESTIMATE_INTENT.bill("e"), ESTIMATE_INTENT.decline("e"), ESTIMATE_INTENT.equipmentAdd, ESTIMATE_INTENT.equipmentReplace("u")])
      .toEqual(["estimate:create", "estimate:sell:e", "estimate:bill:e", "estimate:decline:e", "equipment:add", "equipment:replace:u"]);
  });
  it("a stored write must target this app's tech job routes", () => {
    expect(isStoredWrite(write("/api/tech/jobs/r/estimates"))).toBe(true);
    expect(isStoredWrite({ path: "https://evil.example/x", payload: {} })).toBe(false);
    expect(isStoredWrite({ path: "/api/tech/jobs/r" })).toBe(false);
    expect(isStoredWrite({ path: "/api/tech/jobs/../admin/x", payload: {} })).toBe(false);
    expect(isStoredWrite({ path: "/api/tech/jobs/r/..%2F../x", payload: {} })).toBe(false);
  });
  it("storedToRecover picks matching, well-formed intents", () => {
    expect(storedToRecover(raw, (id) => id.startsWith("estimate:")).map((x) => [x.intentId, x.key])).toEqual([["estimate:sell:e1", "k1"], ["estimate:bill:e2", "k2"]]);
    expect(storedToRecover(raw, (id) => id.startsWith("equipment:"))).toEqual([]);
    expect(storedToRecover(null, () => true)).toEqual([]);
  });
  it("withoutIntent removes one entry and returns null when empty", () => {
    const one = withoutIntent(raw, "estimate:sell:e1");
    expect(storedToRecover(one, () => true).map((x) => x.intentId)).toEqual(["estimate:bill:e2"]);
    expect(withoutIntent(serializeIntents({ a: { phase: "sent", key: "k", bodyHash: "h", body: write("/api/tech/jobs/r/x") } }), "a")).toBeNull();
  });
  it("recovery keeps only answers that are still unknown", () => {
    expect(recoveryKeeps("retry_same_key_after_refetch")).toBe(true);
    expect(recoveryKeeps("wait_then_refetch")).toBe(true);
    for (const o of ["success_refetch", "show_message_refetch", "spent_new_key", "already_saved_refetch", "refetch_new_key"] as const) expect(recoveryKeeps(o)).toBe(false);
  });
  it("write copy: server copy for definitive refusals, our copy for unknowns", () => {
    expect(estimateWriteCopy("retry_same_key_after_refetch", null)).toBe("Your last tap may not have saved. Try again.");
    expect(estimateWriteCopy("wait_then_refetch", null)).toBe("Still saving your last tap…");
    expect(estimateWriteCopy("show_message_refetch", { error: { code: "ALREADY_DECIDED", message: "This estimate was already decided." } })).toBe("This estimate was already decided.");
    expect(estimateWriteCopy("spent_new_key", { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "x" } })).toBe("That tap didn't go through. Try again.");
    expect(estimateWriteCopy("show_message_refetch", null)).toBe("Couldn't save that. Try again.");
  });
});
