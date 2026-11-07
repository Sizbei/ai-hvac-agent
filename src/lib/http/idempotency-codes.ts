/**
 * Dependency-free idempotency constants shared by the server helper
 * (`./idempotency.ts`) and the client reducer. Keep this file import-free so
 * it is safe in a client bundle.
 */

/** Error codes whose response is deterministic for a given request, so the
 * winner stores it (`done`) and a retry with the same key replays it.
 * SEND_FAILED is stored because a pay-link message may already have gone out.
 * M3c adds the estimate and equipment terminal codes (spec §4) and INVOICE_CHANGED
 * (plan ruling 11: the bill's derived invoice was paid or voided, so the next try
 * needs a new key). M3d adds the form-submit terminal codes. */
export const STORED_CODES: ReadonlySet<string> = new Set([
  "INVOICE_LOCKED",
  "NO_LINES",
  "ALREADY_BILLED",
  "ITEM_NOT_FOUND",
  "INVOICE_VOIDED",
  "INVALID_INPUT",
  "VALIDATION_ERROR",
  "SEND_FAILED",
  "ALREADY_DECIDED",
  "ESTIMATE_EXPIRED",
  "INVALID_OPTION",
  "EQUIPMENT_RETIRED",
  "INVOICE_CHANGED",
  // M3d form submit (spec §4.3): terminal for this body; a new tap mints a new key.
  "FORM_SUBMITTED",
  "FORM_INCOMPLETE",
  "ANSWERS_REMOVED",
  "CUSTOMER_REMOVED",
  "ANSWERS_UNREADABLE",
]);

/** On the client a stored code means "this key is spent": mint a new one. */
export const CLIENT_SPENT_CODES: ReadonlySet<string> = STORED_CODES;

/** A fresh key: crypto.randomUUID() when available, else a v4 built from
 * crypto.getRandomValues (non-secure contexts such as a LAN http dev server). */
export function mintKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
