import "server-only";
import {
  lookupCustomerContext,
  type CustomerContext,
} from "@/lib/ai/customer-context";

/** ANI values Twilio sends when the caller ID is unavailable/withheld. */
const ABSENT_ANI = new Set(["", "anonymous", "unavailable", "restricted", "unknown"]);

/**
 * Resolve the calling number (Twilio `From`/ANI) to an existing customer for the
 * org, returning light personalization context (incl. doNotService) or null.
 *
 * Pure read via the shared blind-index lookup. Degrades to null on any error or
 * absent/withheld ANI, so a failed resolution never blocks anonymous intake.
 */
export async function resolveVoiceIdentity(
  organizationId: string,
  ani: string | null | undefined,
): Promise<CustomerContext | null> {
  const trimmed = (ani ?? "").trim();
  if (trimmed.length === 0 || ABSENT_ANI.has(trimmed.toLowerCase())) return null;
  try {
    return await lookupCustomerContext(organizationId, { phone: trimmed });
  } catch (_err: unknown) {
    return null;
  }
}
