/**
 * On-file ZIP loading for the financial-verify gate (brain-unification #2).
 *
 * Was a verbatim copy in BOTH brains (chat route + voice-turn) — pure drift
 * risk on a money-gated path. One implementation now serves both: the ZIPs on
 * a customer's primary address + every service location, decrypted best-effort
 * (a decrypt failure just contributes no ZIP; a read failure logs and moves on
 * — the verify engine treats an empty list as "nothing to match", never a pass).
 */
import { and, count, eq, gt, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, customerLocations, customerSessions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { extractZipsFromAddress } from "./account-verify";
import { logger } from "@/lib/logger";

/** Max service locations scanned for ZIPs (both brains used 10). */
const MAX_LOCATIONS = 10;

/**
 * Cross-session lockout. The per-session limit (MAX_VERIFY_ATTEMPTS) alone is
 * no defence: a session is free to start, and a service area has only a dozen
 * or so ZIPs, so a handful of fresh sessions would guess any customer's ZIP.
 * Once this many of a customer's sessions have FAILED verification inside the
 * window, nothing matches for that customer until those sessions age out — they
 * are sent to the office instead. The cost is accepted: someone who knows a
 * customer's phone number can lock that customer's balance lookup for a day,
 * which is better than letting them guess the ZIP. Booking is unaffected.
 */
const MAX_FAILED_SESSIONS = 3;
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when the customer's recent failed verifications reach the lockout. */
async function isVerifyLockedOut(organizationId: string, customerId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: count() })
    .from(customerSessions)
    .where(
      and(
        eq(customerSessions.organizationId, organizationId),
        eq(customerSessions.customerId, customerId),
        gt(customerSessions.updatedAt, new Date(Date.now() - FAILED_WINDOW_MS)),
        // metadata is a JSON string; the verify engine writes { status, attempts }.
        like(customerSessions.metadata, '%"verify":{"status":"failed"%'),
      ),
    )
    .limit(1);
  return (row?.value ?? 0) >= MAX_FAILED_SESSIONS;
}

export async function loadOnFileZips(
  organizationId: string,
  customerId: string,
  /** For log context only — which session/channel was verifying. */
  sessionId: string,
): Promise<string[]> {
  const zips: string[] = [];
  try {
    const [custRow] = await db
      .select({ addressEncrypted: customers.addressEncrypted })
      .from(customers)
      .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
      .limit(1);
    if (custRow?.addressEncrypted) {
      try {
        zips.push(...extractZipsFromAddress(decrypt(custRow.addressEncrypted)));
      } catch {
        /* decrypt failure → no ZIP from this source */
      }
    }
  } catch (e: unknown) {
    logger.error({ error: e, sessionId }, "verify: customer address read failed");
  }
  try {
    const locRows = await db
      .select({ addressEncrypted: customerLocations.addressEncrypted })
      .from(customerLocations)
      .where(
        withTenant(
          customerLocations,
          organizationId,
          eq(customerLocations.customerId, customerId),
        ),
      )
      .limit(MAX_LOCATIONS);
    for (const loc of locRows) {
      try {
        zips.push(...extractZipsFromAddress(decrypt(loc.addressEncrypted)));
      } catch {
        /* decrypt failure → skip this location */
      }
    }
  } catch (e: unknown) {
    logger.error({ error: e, sessionId }, "verify: location address read failed");
  }
  if (zips.length === 0) return zips;
  try {
    // Locked out → an empty list, which the verify engine can never match.
    if (await isVerifyLockedOut(organizationId, customerId)) {
      logger.warn({ sessionId }, "verify: customer locked out after repeated failed sessions");
      return [];
    }
  } catch (e: unknown) {
    // Fail CLOSED: if the lockout cannot be read, nothing matches.
    logger.error({ error: e, sessionId }, "verify: lockout read failed");
    return [];
  }
  return zips;
}
