/**
 * On-file ZIP loading for the financial-verify gate (brain-unification #2).
 *
 * Was a verbatim copy in BOTH brains (chat route + voice-turn) — pure drift
 * risk on a money-gated path. One implementation now serves both: the ZIPs on
 * a customer's primary address + every service location, decrypted best-effort
 * (a decrypt failure just contributes no ZIP; a read failure logs and moves on
 * — the verify engine treats an empty list as "nothing to match", never a pass).
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, customerLocations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { extractZipsFromAddress } from "./account-verify";
import { logger } from "@/lib/logger";

/** Max service locations scanned for ZIPs (both brains used 10). */
const MAX_LOCATIONS = 10;

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
  return zips;
}
