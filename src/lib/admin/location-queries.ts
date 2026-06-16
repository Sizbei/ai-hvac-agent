/**
 * Stage 5 — customer locations (physical service sites) + per-asset history.
 *
 * One billing customer can hold many service locations. Address is encrypted at
 * rest; an address blind index dedupes a location within a customer.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerLocations, serviceHistory } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt, blindIndex } from "@/lib/crypto";

/** Normalize an address string for blind-index matching (case/space-insensitive). */
function normalizeAddress(addr: string): string {
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

  if (created) return created.id;

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
  return winner!.id;
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
      withTenant(serviceHistory, organizationId, eq(serviceHistory.equipmentId, equipmentId)),
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
