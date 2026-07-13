/**
 * Stage 8 — pricebook + tax queries. Money in integer cents; tax in basis points.
 */
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
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

/**
 * Full admin projection of a single pricebook item, including organizationId so
 * the route can verify ownership before a PATCH/DELETE. Org-scoped defensively.
 */
export interface PricebookItemAdminRow {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly name: string;
  readonly sku: string | null;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly costCents: number;
  readonly markupPct: number;
  readonly priceCents: number;
  readonly memberPriceCents: number | null;
  readonly hours: number | null;
  readonly warranty: string | null;
  readonly active: boolean;
  readonly isLaborItem: boolean;
  readonly fieldpulseItemId: string | null;
  readonly fieldpulseData: Record<string, unknown> | null;
}

const ADMIN_ITEM_PROJECTION = {
  id: pricebookItems.id,
  organizationId: pricebookItems.organizationId,
  type: pricebookItems.type,
  name: pricebookItems.name,
  sku: pricebookItems.sku,
  description: pricebookItems.description,
  categoryId: pricebookItems.categoryId,
  costCents: pricebookItems.costCents,
  markupPct: pricebookItems.markupPct,
  priceCents: pricebookItems.priceCents,
  memberPriceCents: pricebookItems.memberPriceCents,
  hours: pricebookItems.hours,
  warranty: pricebookItems.warranty,
  active: pricebookItems.active,
  isLaborItem: pricebookItems.isLaborItem,
  fieldpulseItemId: pricebookItems.fieldpulseItemId,
  fieldpulseData: pricebookItems.fieldpulseData,
} as const;

export async function getPricebookItemById(
  organizationId: string,
  id: string,
): Promise<PricebookItemAdminRow | null> {
  const [row] = await db
    .select(ADMIN_ITEM_PROJECTION)
    .from(pricebookItems)
    .where(withTenant(pricebookItems, organizationId, eq(pricebookItems.id, id)))
    .limit(1);
  // Drizzle types jsonb columns as `unknown`; we cast to our narrower type.
  return (row as PricebookItemAdminRow | undefined) ?? null;
}

const PRICEBOOK_PAGE_SIZE = 50;

export interface PricebookAdminPage {
  readonly items: readonly PricebookItemAdminRow[];
  readonly total: number;
  readonly types: readonly string[];
}

/** Server-paginated admin list with optional search + type filter. */
export async function listPricebookItemsForAdmin(
  organizationId: string,
  opts: {
    readonly includeInactive?: boolean;
    readonly isLaborItem?: boolean;
    readonly page?: number;
    readonly limit?: number;
    readonly search?: string;
    readonly type?: string;
  } = {},
): Promise<PricebookAdminPage> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.max(1, opts.limit ?? PRICEBOOK_PAGE_SIZE);
  const offset = (page - 1) * limit;

  // Build extra WHERE conditions.
  const extraConditions: SQL[] = [];

  if (!opts.includeInactive) {
    extraConditions.push(eq(pricebookItems.active, true));
  }
  if (opts.isLaborItem) {
    extraConditions.push(eq(pricebookItems.isLaborItem, true));
  }
  if (opts.type) {
    // Cast through sql<> to bypass the enum literal constraint — the DB will
    // reject invalid values, and the route already gates what values arrive.
    extraConditions.push(
      sql`${pricebookItems.type} = ${opts.type}` as SQL,
    );
  }
  if (opts.search?.trim()) {
    const raw = opts.search.trim();
    // Escape SQL LIKE metacharacters in user input.
    const escaped = raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const term = `%${escaped}%`;
    // or() can return undefined when called with 0 args; with 3 it never does.
    const searchClause = or(
      ilike(pricebookItems.name, term),
      ilike(pricebookItems.sku, term),
      ilike(pricebookItems.description, term),
    ) as SQL;
    extraConditions.push(searchClause);
  }

  const whereClause = withTenant(pricebookItems, organizationId, ...extraConditions);

  // Distinct item types for the filter dropdown — runs in parallel.
  const typesPromise = db
    .selectDistinct({ type: pricebookItems.type })
    .from(pricebookItems)
    .where(withTenant(pricebookItems, organizationId, eq(pricebookItems.active, true)))
    .then((rows) =>
      rows
        .map((r) => r.type)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    );

  const countPromise = db
    .select({ n: count() })
    .from(pricebookItems)
    .where(whereClause);

  const rowsPromise = db
    .select(ADMIN_ITEM_PROJECTION)
    .from(pricebookItems)
    .where(whereClause)
    .orderBy(asc(pricebookItems.name))
    .limit(limit)
    .offset(offset) as Promise<PricebookItemAdminRow[]>;

  const [countResult, rows, types] = await Promise.all([
    countPromise,
    rowsPromise,
    typesPromise,
  ]);

  return {
    items: rows,
    total: countResult[0]?.n ?? 0,
    types,
  };
}

export type PricebookItemUpdate = Partial<PricebookItemInput>;

export async function updatePricebookItem(
  organizationId: string,
  id: string,
  partial: PricebookItemUpdate,
): Promise<void> {
  await db
    .update(pricebookItems)
    .set({ ...partial, updatedAt: new Date() })
    .where(
      withTenant(pricebookItems, organizationId, eq(pricebookItems.id, id)),
    );
}

/** Soft delete — line items may FK-reference an item, so never hard delete. */
export async function deactivatePricebookItem(
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(pricebookItems)
    .set({ active: false, updatedAt: new Date() })
    .where(
      withTenant(pricebookItems, organizationId, eq(pricebookItems.id, id)),
    );
}

// ──────────────────────────── tax rates ────────────────────────────

export interface TaxRateRow {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string | null;
  readonly rateBps: number;
  readonly isDefault: boolean;
  readonly active: boolean;
}

export interface TaxRateInput {
  readonly name: string;
  readonly jurisdiction?: string | null;
  readonly rateBps: number;
  readonly isDefault?: boolean;
}

const TAX_PROJECTION = {
  id: taxRates.id,
  name: taxRates.name,
  jurisdiction: taxRates.jurisdiction,
  rateBps: taxRates.rateBps,
  isDefault: taxRates.isDefault,
  active: taxRates.active,
} as const;

/** Active tax rates for an org, default first. */
export async function listTaxRates(
  organizationId: string,
): Promise<readonly TaxRateRow[]> {
  return db
    .select(TAX_PROJECTION)
    .from(taxRates)
    .where(withTenant(taxRates, organizationId, eq(taxRates.active, true)))
    .orderBy(desc(taxRates.isDefault), asc(taxRates.name));
}

export async function getTaxRateById(
  organizationId: string,
  id: string,
): Promise<TaxRateRow | null> {
  const [row] = await db
    .select(TAX_PROJECTION)
    .from(taxRates)
    .where(withTenant(taxRates, organizationId, eq(taxRates.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Clear the org's current default tax rate. Used to maintain the single-default
 * invariant (partial unique index tax_rates_org_default_unique) before setting a
 * new one. Returns the prepared statement so it can be batched.
 */
function buildUnsetDefaultStmt(organizationId: string) {
  return db
    .update(taxRates)
    .set({ isDefault: false })
    .where(
      withTenant(taxRates, organizationId, eq(taxRates.isDefault, true)),
    );
}

export async function createTaxRate(
  organizationId: string,
  input: TaxRateInput,
): Promise<string> {
  if (!input.isDefault) {
    const [row] = await db
      .insert(taxRates)
      .values({
        organizationId,
        name: input.name,
        jurisdiction: input.jurisdiction ?? null,
        rateBps: input.rateBps,
        isDefault: false,
      })
      .returning({ id: taxRates.id });
    return row!.id;
  }

  // Setting this rate as the org default: FIRST unset the prior default, THEN
  // insert the new default. neon-http db.batch runs statements SEQUENTIALLY in
  // array order (it is NOT a serializable transaction) — so the unset MUST come
  // before the set, or the partial unique index would reject two active
  // defaults. We can't batch an insert .returning() reliably across the unset,
  // so unset is batched alone, then we insert.
  await db.batch([buildUnsetDefaultStmt(organizationId)]);
  const [row] = await db
    .insert(taxRates)
    .values({
      organizationId,
      name: input.name,
      jurisdiction: input.jurisdiction ?? null,
      rateBps: input.rateBps,
      isDefault: true,
    })
    .returning({ id: taxRates.id });
  return row!.id;
}

export type TaxRateUpdate = Partial<TaxRateInput>;

export async function updateTaxRate(
  organizationId: string,
  id: string,
  partial: TaxRateUpdate,
): Promise<void> {
  const setFields: Record<string, unknown> = {};
  if (partial.name !== undefined) setFields.name = partial.name;
  if (partial.jurisdiction !== undefined) {
    setFields.jurisdiction = partial.jurisdiction ?? null;
  }
  if (partial.rateBps !== undefined) setFields.rateBps = partial.rateBps;

  if (partial.isDefault === true) {
    // Promote to default. Single-default invariant: unset the prior default
    // FIRST, then set this one (with any other changed fields). neon-http
    // db.batch is sequential (array order), NOT serializable — wrong order would
    // violate tax_rates_org_default_unique.
    await db.batch([
      buildUnsetDefaultStmt(organizationId),
      db
        .update(taxRates)
        .set({ ...setFields, isDefault: true })
        .where(withTenant(taxRates, organizationId, eq(taxRates.id, id))),
    ]);
    return;
  }

  // Explicit demotion (isDefault === false) is a legal change — the partial
  // unique index permits zero defaults — so apply it. (Previously dropped, so
  // the default could never be cleared through this path.)
  if (partial.isDefault === false) setFields.isDefault = false;
  if (Object.keys(setFields).length === 0) return;
  await db
    .update(taxRates)
    .set(setFields)
    .where(withTenant(taxRates, organizationId, eq(taxRates.id, id)));
}

/** Soft delete — preserves rows that invoices may reference. */
export async function deactivateTaxRate(
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(taxRates)
    .set({ active: false, isDefault: false })
    .where(withTenant(taxRates, organizationId, eq(taxRates.id, id)));
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
