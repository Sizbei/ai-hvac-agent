/**
 * Stage 5 — customer locations (physical service sites) + per-asset history.
 *
 * One billing customer can hold many service locations. Address is encrypted at
 * rest; an address blind index dedupes a location within a customer.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerLocations, serviceHistory } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { encrypt, decrypt, blindIndex } from "@/lib/crypto";

/** Normalize an address string for blind-index matching (case/space-insensitive). */
export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase().replace(/\s+/g, " ");
}

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

export interface CustomerLocation {
  readonly id: string;
  readonly address: string | null;
  readonly label: string | null;
  readonly zone: string | null;
  readonly isPrimary: boolean;
}

/**
 * Create (or return the existing) location for a customer, deduped by the
 * normalized-address blind index. Idempotent: a second create with the same
 * address returns the same location id.
 */
export async function upsertCustomerLocation(
  organizationId: string,
  customerId: string,
  input: {
    readonly address: string;
    readonly label?: string | null;
    readonly zone?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
  },
): Promise<string> {
  const normalized = normalizeAddress(input.address);
  const addressHash = normalized.length > 0 ? blindIndex(normalized) : null;

  if (addressHash) {
    const [existing] = await db
      .select({ id: customerLocations.id })
      .from(customerLocations)
      .where(
        and(
          eq(customerLocations.organizationId, organizationId),
          eq(customerLocations.customerId, customerId),
          eq(customerLocations.addressHash, addressHash),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
  }

  const [created] = await db
    .insert(customerLocations)
    .values({
      organizationId,
      customerId,
      addressEncrypted: encrypt(input.address),
      addressHash,
      label: input.label ?? null,
      zone: input.zone ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: customerLocations.id });

  let locationId: string;
  if (created) {
    locationId = created.id;
  } else {
    // Lost a race on the unique index — read the winner back.
    const [winner] = await db
      .select({ id: customerLocations.id })
      .from(customerLocations)
      .where(
        and(
          eq(customerLocations.organizationId, organizationId),
          eq(customerLocations.customerId, customerId),
          addressHash
            ? eq(customerLocations.addressHash, addressHash)
            : eq(customerLocations.customerId, customerId),
        ),
      )
      .limit(1);
    locationId = winner!.id;
  }

  // First location becomes primary. A separate guarded UPDATE (never part of
  // the insert) so a lost race on customer_locations_one_primary_idx is
  // harmless: the predicate re-checks at write time, and a wrapped 23505 from
  // a concurrent winner is swallowed.
  try {
    await db.execute(sql`
      UPDATE customer_locations SET is_primary = true
      WHERE id = ${locationId} AND organization_id = ${organizationId}
        AND NOT EXISTS (SELECT 1 FROM customer_locations p WHERE p.customer_id = ${customerId} AND p.is_primary)`);
  } catch (error: unknown) {
    if (!isUniqueViolation(error, "customer_locations_one_primary_idx"))
      throw error;
  }
  return locationId;
}

export async function locationBelongsToCustomer(
  organizationId: string,
  customerId: string,
  locationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: customerLocations.id })
    .from(customerLocations)
    .where(
      withTenant(
        customerLocations,
        organizationId,
        eq(customerLocations.id, locationId),
        eq(customerLocations.customerId, customerId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function setPrimaryLocation(
  organizationId: string,
  customerId: string,
  locationId: string,
): Promise<boolean | { readonly reason: "race" }> {
  if (
    !(await locationBelongsToCustomer(organizationId, customerId, locationId))
  )
    return false;
  try {
    await db.batch([
      db
        .update(customerLocations)
        .set({ isPrimary: false })
        .where(
          withTenant(
            customerLocations,
            organizationId,
            eq(customerLocations.customerId, customerId),
            eq(customerLocations.isPrimary, true),
          ),
        ),
      db
        .update(customerLocations)
        .set({ isPrimary: true })
        .where(
          withTenant(
            customerLocations,
            organizationId,
            eq(customerLocations.id, locationId),
          ),
        ),
    ]);
  } catch (error: unknown) {
    // Two concurrent "make primary" calls: the second set trips the partial unique index.
    if (isUniqueViolation(error, "customer_locations_one_primary_idx"))
      return { reason: "race" };
    throw error;
  }
  return true;
}

/** List a customer's locations (addresses decrypted). */
export async function listCustomerLocations(
  organizationId: string,
  customerId: string,
): Promise<readonly CustomerLocation[]> {
  const rows = await db
    .select({
      id: customerLocations.id,
      addressEncrypted: customerLocations.addressEncrypted,
      label: customerLocations.label,
      zone: customerLocations.zone,
      isPrimary: customerLocations.isPrimary,
    })
    .from(customerLocations)
    .where(
      and(
        eq(customerLocations.organizationId, organizationId),
        eq(customerLocations.customerId, customerId),
      ),
    )
    .orderBy(desc(customerLocations.createdAt));

  return rows.map((r) => ({
    id: r.id,
    address: safeDecrypt(r.addressEncrypted),
    label: r.label,
    zone: r.zone,
    isPrimary: r.isPrimary,
  }));
}

export interface AssetHistoryEntry {
  readonly id: string;
  readonly serviceRequestId: string | null;
  readonly workPerformed: string | null;
  readonly partsUsed: string | null;
  readonly cost: number | null;
  readonly createdAt: string;
}

/**
 * Per-asset service timeline: every recorded visit against one equipment unit,
 * newest first. Powers the equipment detail panel.
 */
export async function getEquipmentServiceHistory(
  organizationId: string,
  equipmentId: string,
): Promise<readonly AssetHistoryEntry[]> {
  const rows = await db
    .select({
      id: serviceHistory.id,
      serviceRequestId: serviceHistory.serviceRequestId,
      workPerformed: serviceHistory.workPerformed,
      partsUsed: serviceHistory.partsUsed,
      cost: serviceHistory.cost,
      createdAt: serviceHistory.createdAt,
    })
    .from(serviceHistory)
    .where(
      withTenant(
        serviceHistory,
        organizationId,
        eq(serviceHistory.equipmentId, equipmentId),
      ),
    )
    .orderBy(desc(serviceHistory.createdAt));

  return rows.map((r) => ({
    id: r.id,
    serviceRequestId: r.serviceRequestId,
    workPerformed: r.workPerformed,
    partsUsed: r.partsUsed,
    cost: r.cost,
    createdAt: r.createdAt.toISOString(),
  }));
}
