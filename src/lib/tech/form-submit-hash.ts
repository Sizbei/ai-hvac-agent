/**
 * The submit route's idempotency hash input (M3d spec §4.3): the visit, the
 * versions and an HMAC of the canonical changes under its own label, so the
 * stored request hash holds no submitted string and can't be dictionary-
 * attacked back to answers after an erase. Server-only (node:crypto).
 */
import { macHex } from "@/lib/crypto";
import { canonicalJson } from "@/lib/http/idempotency";
import type { SubmitBody } from "@/lib/forms/form-bodies";

export const FORM_CHANGES_LABEL = "hvac-form-changes-v1";

export function submitHashInput(b: SubmitBody): Record<string, unknown> {
  return {
    appointmentId: b.appointmentId.toLowerCase(),
    formVersion: b.formVersion,
    baseRevision: b.baseRevision,
    changesMac: macHex(FORM_CHANGES_LABEL, canonicalJson(b.changes)),
  };
}
