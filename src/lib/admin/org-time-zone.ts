/**
 * The org's business time zone: the IANA zone stored with its after-hours
 * settings (Settings → After hours), else the system default (Eastern).
 * Hour-of-day charts and "today" labels use it, never UTC or the viewer's clock.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { resolveAfterHoursConfig } from "./after-hours";

export async function getOrgTimeZone(organizationId: string): Promise<string> {
  const [row] = await db
    .select({ afterHoursConfig: organizationSettings.afterHoursConfig })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return resolveAfterHoursConfig(row?.afterHoursConfig ?? null).timezone;
}
