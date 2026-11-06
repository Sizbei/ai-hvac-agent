import { describe, it, expect } from "vitest";
import { equipmentError, equipmentReasonResult } from "./equipment-errors";
import { isStorable } from "@/lib/http/idempotency";

describe("equipment reasons", () => {
  it.each([
    ["no_customer", 409, "NO_CUSTOMER", "Ask the office to add the customer first."],
    ["not_found", 404, "NOT_FOUND", "That unit isn't at this address."],
    ["equipment_retired", 409, "EQUIPMENT_RETIRED", "That unit was already replaced."],
    ["managed_externally", 409, "MANAGED_EXTERNALLY", "That unit is managed in FieldPulse."],
    ["stale", 409, "STALE", "This job changed. Try again."],
  ] as const)("%s", (reason, status, code, message) => expect(equipmentError(reason)).toEqual({ status, code, message }));
  it("only EQUIPMENT_RETIRED is stored", () => {
    const r = equipmentReasonResult("equipment_retired");
    expect(isStorable(r.status, r.envelope)).toBe(true);
    const n = equipmentReasonResult("not_found");
    expect(isStorable(n.status, n.envelope)).toBe(false);
  });
});
