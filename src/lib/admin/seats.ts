import "server-only";

import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { getOrgEntitlements } from "@/lib/billing/entitlements";
import type { SeatUsage } from "./seat-usage";

/**
 * Active users vs the plan's maxStaff for one org. The single source for the
 * seat gate: invites (createInvite) and direct staff creation (POST
 * /api/admin/staff) both check it, and the Staff page shows it.
 */
export async function getSeatUsage(organizationId: string): Promise<SeatUsage> {
  const { entitlements } = await getOrgEntitlements(organizationId);
  const [seatRow] = await db
    .select({ value: count() })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.isActive, true)));
  // neon-http returns count() as a string.
  return { used: Number(seatRow?.value ?? 0), limit: entitlements.maxStaff };
}
