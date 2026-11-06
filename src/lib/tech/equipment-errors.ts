/** Reason → HTTP status / code / copy for the field equipment route (M3c spec §5.6). */
import type { RunResult } from "@/lib/http/idempotency";
import type { EquipmentReason } from "@/lib/tech/equipment-writes";

type Shape = { status: number; code: string; message: string };

const MAP: Record<EquipmentReason, Shape> = {
  no_customer: { status: 409, code: "NO_CUSTOMER", message: "Ask the office to add the customer first." },
  not_found: { status: 404, code: "NOT_FOUND", message: "That unit isn't at this address." },
  equipment_retired: { status: 409, code: "EQUIPMENT_RETIRED", message: "That unit was already replaced." },
  managed_externally: { status: 409, code: "MANAGED_EXTERNALLY", message: "That unit is managed in FieldPulse." },
  stale: { status: 409, code: "STALE", message: "This job changed. Try again." },
};

export function equipmentReasonResult(reason: EquipmentReason): RunResult {
  const { status, code, message } = MAP[reason];
  return { status, envelope: { success: false, error: { message, code } } };
}
