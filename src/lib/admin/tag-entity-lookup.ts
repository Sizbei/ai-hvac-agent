import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, customerLocations, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TagEntity } from "./tag-types";

/** True when `[entity]/[id]` exists in this org. Path ids are never trusted. */
export async function taggableExists(organizationId: string, entity: TagEntity, id: string): Promise<boolean> {
  const query =
    entity === "customer" ? db.select({ id: customers.id }).from(customers).where(withTenant(customers, organizationId, eq(customers.id, id)))
    : entity === "location" ? db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.id, id)))
    : db.select({ id: serviceRequests.id }).from(serviceRequests).where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, id)));
  const [row] = await query.limit(1);
  return Boolean(row);
}
