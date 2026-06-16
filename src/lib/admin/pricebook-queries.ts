/**
 * Stage 8 — pricebook + tax queries. Money in integer cents; tax in basis points.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pricebookItems, taxRates } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export type PricebookItemType = "service" | "material" | "equipment";

export interface PricebookItemInput {
  readonly categoryId?: string | null;
  readonly type: PricebookItemType;
  readonly name: string;
  readonly description?: string | null;
  readonly sku?: string | null;
  readonly costCents?: number;
  readonly markupPct?: number;
  readonly priceCents: number;
  readonly memberPriceCents?: number | null;
  readonly hours?: number | null;
  readonly warranty?: string | null;
}

export async function createPricebookItem(
  organizationId: string,
  input: PricebookItemInput,
): Promise<string> {
  const [row] = await db
    .insert(pricebookItems)
    .values({
      organizationId,
      categoryId: input.categoryId ?? null,
      type: input.type,
      name: input.name,
      description: input.description ?? null,
      sku: input.sku ?? null,
      costCents: input.costCents ?? 0,
      markupPct: input.markupPct ?? 0,
      priceCents: input.priceCents,
      memberPriceCents: input.memberPriceCents ?? null,
      hours: input.hours ?? null,
      warranty: input.warranty ?? null,
    })
    .returning({ id: pricebookItems.id });
  return row!.id;
}

export interface PricebookItemRow {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly priceCents: number;
  readonly memberPriceCents: number | null;
  readonly hours: number | null;
}

/** Active pricebook items for an org (for admin lists + AI quoting). */
export async function listPricebookItems(
  organizationId: string,
): Promise<readonly PricebookItemRow[]> {
  return db
    .select({
      id: pricebookItems.id,
      type: pricebookItems.type,
      name: pricebookItems.name,
      priceCents: pricebookItems.priceCents,
      memberPriceCents: pricebookItems.memberPriceCents,
      hours: pricebookItems.hours,
    })
    .from(pricebookItems)
    .where(
      withTenant(pricebookItems, organizationId, eq(pricebookItems.active, true)),
    )
    .orderBy(asc(pricebookItems.name));
}

/** The org's default tax rate in basis points (0 when none configured). */
export async function getDefaultTaxBps(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ rateBps: taxRates.rateBps })
    .from(taxRates)
    .where(
      withTenant(
        taxRates,
        organizationId,
        and(eq(taxRates.isDefault, true), eq(taxRates.active, true))!,
      ),
    )
    .limit(1);
  return row?.rateBps ?? 0;
}
