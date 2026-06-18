/**
 * Shared account-lookup dispatcher used by both the web chat route and the voice
 * agent. Extracted from src/app/api/chat/route.ts so both channels can call the
 * same deterministic logic without duplication.
 *
 * The caller MUST have already enforced the identity gate (customerId is the
 * resolved, org-scoped customer). These functions trust their inputs.
 */
import {
  getMembershipSummary,
  getNextVisit,
  getOpenBalance,
  getUpcomingAppointment,
  requestReschedule,
} from "@/lib/ai/account-tools";
import {
  membershipReply,
  nextVisitReply,
  balanceReply,
  appointmentReply,
  rescheduleReply,
} from "@/lib/ai/account-reply";

// Each account capability, keyed by a stable name. The new account_data intents
// map 1:1; the legacy reference intents (which still win the phrase match and
// return as FALLBACK_LLM with their intentId) map to the closest capability so an
// identified customer gets a real answer instead of an LLM punt.
type AccountCapability =
  | "membership"
  | "next_visit"
  | "balance"
  | "appointment"
  | "reschedule";

export const ACCOUNT_INTENT_CAPABILITY: Record<string, AccountCapability> = {
  // New v1 account_data intents.
  "account-data-membership-status": "membership",
  "account-data-next-visit": "next_visit",
  "account-data-balance": "balance",
  "account-data-appointment-status": "appointment",
  "account-data-reschedule": "reschedule",
};

// Legacy reference intents the router returns as FALLBACK_LLM (with intentId
// preserved). For an IDENTIFIED session these now resolve to an account tool;
// unidentified sessions never reach this map (they keep the LLM identify path).
// scheduling-cancel is deliberately absent — cancel is NOT in the safe v1 set.
const LEGACY_ACCOUNT_INTENT_TOOL: Record<string, AccountCapability> = {
  "membership-account": "membership",
  "account-check-status": "appointment",
  "account-change-appointment": "reschedule",
  "scheduling-reschedule": "reschedule",
};

/**
 * Dispatch an identified-customer account intent to the matching read-tool and
 * assemble a deterministic, pricing-safe reply. The caller has ALREADY enforced
 * the identity gate (customerId is the resolved, org-scoped customer).
 *
 * The reschedule capability records a STAFF HAND-OFF (a request note) and never
 * mutates the schedule. Money is formatted at the reply layer (account-reply.ts).
 * Returns null for an unrecognized intent id so the caller falls through to the
 * normal path. Reads/writes are awaited HERE (before the response is returned),
 * so on serverless they complete within the request — no detached promise that
 * the platform freeze would kill.
 */
export async function buildAccountLookupReply(
  intentId: string | null,
  organizationId: string,
  customerId: string,
  message: string,
): Promise<string | null> {
  const capability =
    (intentId && ACCOUNT_INTENT_CAPABILITY[intentId]) ||
    (intentId && LEGACY_ACCOUNT_INTENT_TOOL[intentId]) ||
    null;
  switch (capability) {
    case "membership": {
      const summary = await getMembershipSummary(organizationId, customerId);
      return membershipReply(summary);
    }
    case "next_visit": {
      const visit = await getNextVisit(organizationId, customerId);
      return nextVisitReply(visit);
    }
    case "balance": {
      const balance = await getOpenBalance(organizationId, customerId);
      return balanceReply(balance);
    }
    case "appointment": {
      const appointment = await getUpcomingAppointment(
        organizationId,
        customerId,
      );
      return appointmentReply(appointment);
    }
    case "reschedule": {
      const handoff = await requestReschedule(
        organizationId,
        customerId,
        message,
      );
      return rescheduleReply(handoff);
    }
    default:
      return null;
  }
}
