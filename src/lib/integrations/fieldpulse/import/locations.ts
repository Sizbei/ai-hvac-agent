/**
 * Phase 11 — FieldPulse locations inbound pull (address enrichment).
 *
 * importLocationsFromFieldpulse pages the full /locations list and writes an
 * address to any native customer whose addressEncrypted is currently NULL.
 *
 * Resolution:
 *  1. Only process object_type ending in "BaseCustomer" (ignore BaseInvoice etc).
 *  2. Resolve the native customer by fieldpulseCustomerId (object_id).
 *  3. Skip if the customer's addressEncrypted IS NOT NULL (never overwrite).
 *  4. Compose address from location fields (sanitize+encrypt exactly like customers.ts).
 *  5. Write addressEncrypted if any address parts are present.
 *
 * Live-verified 2026-07-09: object_types seen = BaseCustomer + BaseInvoice.
 */
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { encrypt } from "@/lib/crypto";
import { sanitizeAddress } from "@/lib/ai/sanitize-fields";
import type { FieldpulseClient } from "../client";
import type { FieldpulseLocation } from "../types";
import type { PhaseResult } from "./run-import";

// ── Mapper ─────────────────────────────────────────────────────────────────────

export interface MappedFpLocation {
  readonly fpCustomerId: string;
  readonly address: string;
}

export type MapLocationResult =
  | { readonly ok: true; readonly location: MappedFpLocation }
  | { readonly ok: false; readonly reason: "not-customer" | "no-address" | "no-object-id" };

/**
 * Pure mapper: FieldpulseLocation → MappedFpLocation or skip.
 * Only BaseCustomer records are mapped; others return reason "not-customer".
 */
export function mapFpLocation(fp: FieldpulseLocation): MapLocationResult {
  // Live-verified: objectType is "BaseCustomer" or "BaseInvoice".
  if (!fp.objectType?.endsWith("BaseCustomer")) {
    return { ok: false, reason: "not-customer" };
  }
  const fpCustomerId = fp.objectId?.trim() || null;
  if (!fpCustomerId) {
    return { ok: false, reason: "no-object-id" };
  }
  const address = composeLocationAddress(fp);
  if (!address) {
    return { ok: false, reason: "no-address" };
  }
  return {
    ok: true,
    location: { fpCustomerId, address },
  };
}

function composeLocationAddress(fp: FieldpulseLocation): string | null {
  const parts: string[] = [];
  const street = fp.address1?.trim();
  const street2 = fp.address2?.trim();
  const city = fp.city?.trim();
  const state = fp.state?.trim();
  const zip = fp.zipCode?.trim();

  if (street) parts.push(street);
  if (street2) parts.push(street2);

  const cityStateZip = [city, state && zip ? `${state} ${zip}` : state ?? zip]
    .filter(Boolean)
    .join(", ");
  if (cityStateZip) parts.push(cityStateZip);

  return parts.length > 0 ? parts.join(", ") : null;
}

// ── Importer ───────────────────────────────────────────────────────────────────

export async function importLocationsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount } = await client.listLocations();
  counts.fetched = items.length;
  counts.total = totalCount ?? null;

  if (totalCount !== null && items.length < totalCount) {
    logger.warn(
      { orgId, fetched: items.length, totalCount, shortfall: totalCount - items.length },
      "FP location pull: fetched fewer rows than total_count — possible partial walk; check maxPages",
    );
  }

  // Pre-select customers by fieldpulseCustomerId → { id, addressEncrypted } for O(1) lookup.
  const customerRows = await db
    .select({
      id: customers.id,
      fieldpulseCustomerId: customers.fieldpulseCustomerId,
      addressEncrypted: customers.addressEncrypted,
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, orgId),
        isNotNull(customers.fieldpulseCustomerId),
      ),
    );
  const customerByFpId = new Map(
    customerRows.map((r) => [
      r.fieldpulseCustomerId as string,
      { id: r.id, hasAddress: r.addressEncrypted !== null },
    ]),
  );

  let ignoredCount = 0;

  for (const fp of items) {
    const mapped = mapFpLocation(fp);
    if (!mapped.ok) {
      if (mapped.reason === "not-customer") {
        ignoredCount++;
      } else {
        counts.skipped++;
      }
      continue;
    }

    const { location } = mapped;

    try {
      const native = customerByFpId.get(location.fpCustomerId) ?? null;
      if (!native) {
        counts.skipped++;
        continue;
      }

      if (native.hasAddress) {
        // Never overwrite an existing address.
        counts.skippedHasAddress = (counts.skippedHasAddress ?? 0) + 1;
        counts.skipped++;
        continue;
      }

      // Write the address.
      await db
        .update(customers)
        .set({
          addressEncrypted: encrypt(sanitizeAddress(location.address)),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customers.id, native.id),
            eq(customers.organizationId, orgId),
            // Double-check: only write if still null (avoid race).
            isNull(customers.addressEncrypted),
          ),
        );

      counts.enriched = (counts.enriched ?? 0) + 1;
      counts.updated++;
      // Mark local cache as having an address so subsequent locations for the
      // same customer (multiple FP locations) don't attempt a second write.
      native.hasAddress = true;
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpLocationId: fp.id,
          fpCustomerId: location.fpCustomerId,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP location import: per-record error (continuing)",
      );
    }
  }

  if (ignoredCount > 0) {
    logger.info(
      { orgId, ignoredCount },
      "FP location import: ignored non-BaseCustomer locations (BaseInvoice etc.)",
    );
  }
}
