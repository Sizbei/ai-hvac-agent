/**
 * Stage 9 — estimates / good-better-best proposals.
 *
 * Line items are SNAPSHOTTED (name + price copied at quote time) so later
 * pricebook edits never mutate a sent quote. Approval is via a tokenized public
 * page (hashed token at rest, like staff invites) with typed-name e-signature +
 * IP/timestamp capture.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  estimateOptions,
  estimateLineItems,
  customers,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { withTenant } from "@/lib/db/tenant";
import { computeOptionTotals, lineTotalCents } from "./money";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface EstimateOptionInput {
  readonly name: string;
  readonly lineItems: ReadonlyArray<{
    readonly pricebookItemId?: string | null;
    readonly name: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
    /** Cost snapshot at quote time (0 for manual lines). Used for margin later. */
    readonly costCents?: number;
  }>;
}

export interface CreateEstimateResult {
  readonly estimateId: string;
  /** Plaintext approval token — returned ONCE (only its hash is stored). */
  readonly approvalToken: string;
}

/**
 * Create an estimate with its option tiers + snapshotted line items, atomically
 * (db.batch). Returns the id and a one-time approval token for the public page.
 */
export async function createEstimate(
  organizationId: string,
  input: {
    readonly serviceRequestId?: string | null;
    readonly customerId?: string | null;
    readonly taxBps: number;
    readonly options: readonly EstimateOptionInput[];
    readonly expiresInDays?: number;
  },
): Promise<CreateEstimateResult> {
  const estimateId = randomUUID();
  const approvalToken = randomBytes(24).toString("hex");
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  // Pre-compute totals + ids so all inserts go in one batch.
  const optionRows: Array<{
    id: string;
    name: string;
    sortOrder: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  }> = [];
  const lineRows: Array<{
    id: string;
    optionId: string;
    pricebookItemId: string | null;
    name: string;
    quantity: number;
    unitPriceCents: number;
    costCents: number;
    lineTotalCents: number;
  }> = [];

  input.options.forEach((opt, i) => {
    const optionId = randomUUID();
    const totals = computeOptionTotals(opt.lineItems, input.taxBps);
    optionRows.push({
      id: optionId,
      name: opt.name,
      sortOrder: i,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    });
    for (const li of opt.lineItems) {
      lineRows.push({
        id: randomUUID(),
        optionId,
        pricebookItemId: li.pricebookItemId ?? null,
        name: li.name,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        costCents: li.costCents ?? 0,
        // Use the SAME helper that feeds option/invoice totals so the stored
        // per-line value can't diverge from the rolled-up subtotal.
        lineTotalCents: lineTotalCents(li),
      });
    }
  });

  const headlineTotal = optionRows.reduce((m, o) => Math.max(m, o.totalCents), 0);

  const estimateInsert = db.insert(estimates).values({
    id: estimateId,
    organizationId,
    serviceRequestId: input.serviceRequestId ?? null,
    customerId: input.customerId ?? null,
    status: "open",
    totalCents: headlineTotal,
    approvalTokenHash: hashToken(approvalToken),
    expiresAt,
  });
  const optionsInsert = db.insert(estimateOptions).values(
    optionRows.map((o) => ({ ...o, organizationId, estimateId })),
  );
  if (lineRows.length > 0) {
    await db.batch([
      estimateInsert,
      optionsInsert,
      db.insert(estimateLineItems).values(
        lineRows.map((l) => ({ ...l, organizationId })),
      ),
    ]);
  } else {
    await db.batch([estimateInsert, optionsInsert]);
  }

  return { estimateId, approvalToken };
}

export type ApproveEstimateResult =
  | { readonly ok: true; readonly estimateId: string }
  | { readonly ok: false; readonly reason: "not_found" | "expired" | "already_decided" | "invalid_option" | "synced_read_only" };

/**
 * Approve + e-sign an estimate from the public token page: flips it to "sold",
 * records the chosen option, signature name, IP, and timestamp. Idempotency:
 * a second approval of an already-decided estimate returns already_decided.
 */
export async function approveEstimate(params: {
  readonly token: string;
  readonly optionId: string;
  readonly signatureName: string;
  readonly signatureIp: string;
  readonly now?: Date;
}): Promise<ApproveEstimateResult> {
  const now = params.now ?? new Date();
  const [est] = await db
    .select({
      id: estimates.id,
      organizationId: estimates.organizationId,
      status: estimates.status,
      expiresAt: estimates.expiresAt,
    })
    .from(estimates)
    .where(eq(estimates.approvalTokenHash, hashToken(params.token)))
    .limit(1);

  if (!est) return { ok: false, reason: "not_found" };
  if (est.status !== "open") return { ok: false, reason: "already_decided" };
  if (est.expiresAt && est.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  // The chosen option must belong to this estimate AND this estimate's org
  // (defense-in-depth: a tampered optionId from another tenant cannot pass).
  const [opt] = await db
    .select({ id: estimateOptions.id })
    .from(estimateOptions)
    .where(
      withTenant(
        estimateOptions,
        est.organizationId,
        eq(estimateOptions.estimateId, est.id),
        eq(estimateOptions.id, params.optionId),
      ),
    )
    .limit(1);
  if (!opt) return { ok: false, reason: "invalid_option" };

  // Status-guarded update closes the double-approval race.
  // isNull(fieldpulseEstimateId) is defense-in-depth: synced FP estimates carry
  // no approvalTokenHash so this branch is unreachable for them today, but the
  // gate keeps that invariant honest in case the lookup path ever changes.
  const [updated] = await db
    .update(estimates)
    .set({
      status: "sold",
      soldOptionId: params.optionId,
      signedAt: now,
      signatureName: params.signatureName.slice(0, 200),
      signatureIp: params.signatureIp,
      updatedAt: now,
    })
    .where(and(eq(estimates.id, est.id), eq(estimates.status, "open"), isNull(estimates.fieldpulseEstimateId)))
    .returning({ id: estimates.id });

  if (!updated) return { ok: false, reason: "already_decided" };
  return { ok: true, estimateId: updated.id };
}

export interface EstimateListRow {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly signedAt: Date | null;
  /** Which FSM this estimate is a read-only mirror of, or null when native. */
  readonly syncedSource: "fieldpulse" | null;
  /** Human-readable status label from FieldPulse (e.g. "Sent"). Null for native estimates. */
  readonly fieldpulseStatusName: string | null;
  /** Human-readable estimate title from FieldPulse. Null for native estimates. */
  readonly title: string | null;
  /** FieldPulse spillover data; null for native estimates. */
  readonly fieldpulseData: Record<string, unknown> | null;
  /** Decrypted customer name from the joined customers row. Null when no customer. */
  readonly customerName: string | null;
  /** ISO string of the effective created-at (FieldPulse created_at if present, else native). */
  readonly effectiveCreatedAt: string;
}

const ESTIMATE_PAGE_SIZE = 50;

// ─── Bucket SQL expression ────────────────────────────────────────────────────
// Single source of truth for bucket classification. Used in both stats and list.
// Priority: fieldpulse_status_name (case-insensitive) → native status.
const BUCKET_CASE_SQL = sql`
  CASE
    WHEN lower(${estimates.fieldpulseStatusName}) IN ('accepted','completed') OR ${estimates.status} = 'sold' THEN 'won'
    WHEN lower(${estimates.fieldpulseStatusName}) = 'lost' OR ${estimates.status} IN ('dismissed','expired') THEN 'lost'
    WHEN lower(${estimates.fieldpulseStatusName}) = 'draft' THEN 'draft'
    ELSE 'open'
  END
`;

// Effective created-at: prefer the FieldPulse created_at (stored in jsonb) over native.
// NOTE: in practice the jsonb arm is inert — the FP import promotes created_at into the
// native createdAt column and the spillover denylist keeps it out of fieldpulse_data,
// so coalesce always falls through to createdAt (which holds FP's real creation time
// for synced rows). The jsonb arm stays as spec-mandated defense should either of
// those pipelines change.
const EFFECTIVE_CREATED_AT_SQL = sql`
  coalesce(
    (${estimates.fieldpulseData}->>'created_at')::timestamp AT TIME ZONE 'UTC',
    ${estimates.createdAt}
  )
`;

export interface EstimatePipelineStats {
  readonly openCents: number;
  readonly openCount: number;
  readonly staleCents: number;
  readonly staleCount: number;
  readonly wonCents: number;
  readonly wonCount: number;
  readonly lostCents: number;
  readonly lostCount: number;
  readonly draftCents: number;
  readonly draftCount: number;
  readonly winRatePct: number | null;
  readonly avgOpenAgeDays: number;
}

/**
 * Aggregate pipeline stats for the estimates board. One SQL round-trip using
 * FILTER clauses (same pattern as getInvoiceSummaryStats in invoice-queries.ts).
 */
export async function getEstimatePipelineStats(
  organizationId: string,
): Promise<EstimatePipelineStats> {
  const [row] = await db
    .select({
      openCents: sql<number>`coalesce(sum(${estimates.totalCents}) filter (where (${BUCKET_CASE_SQL}) = 'open'), 0)::bigint`,
      openCount: sql<number>`count(*) filter (where (${BUCKET_CASE_SQL}) = 'open')::int`,
      staleCents: sql<number>`coalesce(sum(${estimates.totalCents}) filter (where (${BUCKET_CASE_SQL}) = 'open' and (${EFFECTIVE_CREATED_AT_SQL}) < now() - interval '14 days'), 0)::bigint`,
      staleCount: sql<number>`count(*) filter (where (${BUCKET_CASE_SQL}) = 'open' and (${EFFECTIVE_CREATED_AT_SQL}) < now() - interval '14 days')::int`,
      wonCents: sql<number>`coalesce(sum(${estimates.totalCents}) filter (where (${BUCKET_CASE_SQL}) = 'won'), 0)::bigint`,
      wonCount: sql<number>`count(*) filter (where (${BUCKET_CASE_SQL}) = 'won')::int`,
      lostCents: sql<number>`coalesce(sum(${estimates.totalCents}) filter (where (${BUCKET_CASE_SQL}) = 'lost'), 0)::bigint`,
      lostCount: sql<number>`count(*) filter (where (${BUCKET_CASE_SQL}) = 'lost')::int`,
      draftCents: sql<number>`coalesce(sum(${estimates.totalCents}) filter (where (${BUCKET_CASE_SQL}) = 'draft'), 0)::bigint`,
      draftCount: sql<number>`count(*) filter (where (${BUCKET_CASE_SQL}) = 'draft')::int`,
      winRatePct: sql<number | null>`
        case when (
          count(*) filter (where (${BUCKET_CASE_SQL}) IN ('won','lost'))
        ) = 0 then null
        else round(100.0 * count(*) filter (where (${BUCKET_CASE_SQL}) = 'won') /
          count(*) filter (where (${BUCKET_CASE_SQL}) IN ('won','lost')))
        end
      `,
      avgOpenAgeDays: sql<number>`coalesce(round(avg(extract(epoch from now() - (${EFFECTIVE_CREATED_AT_SQL})) / 86400) filter (where (${BUCKET_CASE_SQL}) = 'open')), 0)::int`,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId));

  return {
    openCents: Number(row?.openCents ?? 0),
    openCount: Number(row?.openCount ?? 0),
    staleCents: Number(row?.staleCents ?? 0),
    staleCount: Number(row?.staleCount ?? 0),
    wonCents: Number(row?.wonCents ?? 0),
    wonCount: Number(row?.wonCount ?? 0),
    lostCents: Number(row?.lostCents ?? 0),
    lostCount: Number(row?.lostCount ?? 0),
    draftCents: Number(row?.draftCents ?? 0),
    draftCount: Number(row?.draftCount ?? 0),
    winRatePct: row?.winRatePct != null ? Number(row.winRatePct) : null,
    avgOpenAgeDays: Number(row?.avgOpenAgeDays ?? 0),
  };
}

/** Decrypt an encrypted name for display; null on absent/garbled ciphertext. */
function safeDecryptName(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Admin list of an org's estimates, newest first, with server-side pagination. */
export async function listEstimates(
  organizationId: string,
  opts: {
    readonly page?: number;
    readonly limit?: number;
    readonly customerId?: string;
    readonly serviceRequestId?: string;
    readonly bucket?: 'open' | 'won' | 'lost' | 'draft';
    readonly search?: string;
  } = {},
): Promise<{ estimates: EstimateListRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.max(1, opts.limit ?? ESTIMATE_PAGE_SIZE);
  const offset = (page - 1) * limit;
  const search = opts.search?.trim().toLowerCase() ?? "";

  const extraConditions: SQL[] = [];
  if (opts.customerId) extraConditions.push(eq(estimates.customerId, opts.customerId));
  if (opts.serviceRequestId) extraConditions.push(eq(estimates.serviceRequestId, opts.serviceRequestId));
  if (opts.bucket) {
    extraConditions.push(sql`(${BUCKET_CASE_SQL}) = ${opts.bucket}`);
  }

  const whereClause = withTenant(estimates, organizationId, ...extraConditions);

  // Open bucket: show oldest first (pipeline triage order); all others newest first.
  const orderByClause = opts.bucket === 'open'
    ? asc(EFFECTIVE_CREATED_AT_SQL)
    : desc(EFFECTIVE_CREATED_AT_SQL);

  const rowCols = {
    id: estimates.id,
    status: estimates.status,
    totalCents: estimates.totalCents,
    customerId: estimates.customerId,
    serviceRequestId: estimates.serviceRequestId,
    createdAt: estimates.createdAt,
    expiresAt: estimates.expiresAt,
    signedAt: estimates.signedAt,
    fieldpulseEstimateId: estimates.fieldpulseEstimateId,
    fieldpulseStatusName: estimates.fieldpulseStatusName,
    title: estimates.title,
    fieldpulseData: estimates.fieldpulseData,
    nameEncrypted: customers.nameEncrypted,
    effectiveCreatedAt: EFFECTIVE_CREATED_AT_SQL,
  };

  if (search) {
    // Customer name is encrypted — decrypt every row server-side and filter.
    // Title is plaintext so we match it in JS after the full-table fetch.
    // Load ALL matching rows (no pagination), decrypt, filter, then slice.
    // Cap the decrypt-scan to the most recent 5 000 rows (newest-first ordering
    // is already applied) — mirrors the SCAN_LIMIT_ESTIMATES cap in search-queries.ts.
    // Without this the query fetches ALL org rows on every keystroke.
    const allRows = await db
      .select(rowCols)
      .from(estimates)
      .leftJoin(
        customers,
        and(
          eq(customers.id, estimates.customerId),
          eq(customers.organizationId, organizationId),
        ),
      )
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(5000);

    const filtered = allRows.filter(({ nameEncrypted, title }) => {
      const name = safeDecryptName(nameEncrypted ?? null);
      return (
        (name ?? "").toLowerCase().includes(search) ||
        (title ?? "").toLowerCase().includes(search)
      );
    });

    const sliced = filtered.slice(offset, offset + limit);
    const estimateRows = sliced.map(({ fieldpulseEstimateId, fieldpulseStatusName, fieldpulseData, nameEncrypted, effectiveCreatedAt, ...r }) => ({
      ...r,
      syncedSource: fieldpulseEstimateId != null ? ("fieldpulse" as const) : null,
      fieldpulseStatusName: fieldpulseStatusName ?? null,
      fieldpulseData: (fieldpulseData as Record<string, unknown> | null) ?? null,
      customerName: safeDecryptName(nameEncrypted ?? null),
      effectiveCreatedAt: effectiveCreatedAt instanceof Date
        ? effectiveCreatedAt.toISOString()
        : String(effectiveCreatedAt ?? new Date(r.createdAt).toISOString()),
    }));

    return { estimates: estimateRows, total: filtered.length };
  }

  const [countResult, rows] = await Promise.all([
    db.select({ n: count() }).from(estimates).where(whereClause),
    db
      .select(rowCols)
      .from(estimates)
      // Org-scope the join too (defense in depth).
      .leftJoin(
        customers,
        and(
          eq(customers.id, estimates.customerId),
          eq(customers.organizationId, organizationId),
        ),
      )
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(limit)
      .offset(offset),
  ]);

  const total = countResult[0]?.n ?? 0;
  const estimateRows = rows.map(({ fieldpulseEstimateId, fieldpulseStatusName, fieldpulseData, nameEncrypted, effectiveCreatedAt, ...r }) => ({
    ...r,
    syncedSource: fieldpulseEstimateId != null ? ("fieldpulse" as const) : null,
    fieldpulseStatusName: fieldpulseStatusName ?? null,
    fieldpulseData: (fieldpulseData as Record<string, unknown> | null) ?? null,
    customerName: safeDecryptName(nameEncrypted ?? null),
    effectiveCreatedAt: effectiveCreatedAt instanceof Date
      ? effectiveCreatedAt.toISOString()
      : String(effectiveCreatedAt ?? new Date(r.createdAt).toISOString()),
  }));

  return { estimates: estimateRows, total };
}

export interface EstimateLineItemView {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Snapshotted cost (ADMIN-ONLY — never exposed on the public approval read). */
  readonly costCents: number;
  readonly lineTotalCents: number;
}

export interface EstimateOptionView {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly lineItems: EstimateLineItemView[];
}

export interface EstimateDetailView {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly soldOptionId: string | null;
  readonly signedAt: Date | null;
  readonly signatureName: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  /** FieldPulse estimate due date (from FP `due_date`); null for native estimates. */
  readonly dueDate: Date | null;
  readonly options: EstimateOptionView[];
  /** Which FSM this estimate is a read-only mirror of, or null when native. */
  readonly syncedSource: "fieldpulse" | null;
  /** Human-readable status label from FieldPulse (e.g. "Sent"). Null for native estimates. */
  readonly fieldpulseStatusName: string | null;
  /** Human-readable estimate title from FieldPulse. Null for native estimates. */
  readonly title: string | null;
  /** FieldPulse spillover data for the detail panel; null when not a FP estimate or empty. */
  readonly fieldpulseData: Record<string, unknown> | null;
}

/**
 * Group an estimate's options + their line items into the nested view shape.
 * Shared by the admin detail read and the public approval read.
 *
 * `includeCost` gates the SENSITIVE snapshotted cost: it is fetched ONLY for the
 * admin detail read. The public approval read passes false (the default) so cost
 * never reaches a customer-facing surface. When false, costCents is reported as 0.
 */
async function loadOptionsWithLineItems(
  organizationId: string,
  estimateId: string,
  includeCost = false,
): Promise<EstimateOptionView[]> {
  const optionRows = await db
    .select({
      id: estimateOptions.id,
      name: estimateOptions.name,
      sortOrder: estimateOptions.sortOrder,
      subtotalCents: estimateOptions.subtotalCents,
      taxCents: estimateOptions.taxCents,
      totalCents: estimateOptions.totalCents,
    })
    .from(estimateOptions)
    .where(
      withTenant(
        estimateOptions,
        organizationId,
        eq(estimateOptions.estimateId, estimateId),
      ),
    )
    .orderBy(asc(estimateOptions.sortOrder));

  if (optionRows.length === 0) return [];

  const optionIds = optionRows.map((o) => o.id);
  const lineRows = await db
    .select({
      id: estimateLineItems.id,
      optionId: estimateLineItems.optionId,
      pricebookItemId: estimateLineItems.pricebookItemId,
      name: estimateLineItems.name,
      quantity: estimateLineItems.quantity,
      unitPriceCents: estimateLineItems.unitPriceCents,
      costCents: estimateLineItems.costCents,
      lineTotalCents: estimateLineItems.lineTotalCents,
    })
    .from(estimateLineItems)
    .where(
      withTenant(
        estimateLineItems,
        organizationId,
        inArray(estimateLineItems.optionId, optionIds),
      ),
    )
    .orderBy(asc(estimateLineItems.id));

  const byOption = new Map<string, EstimateLineItemView[]>();
  for (const l of lineRows) {
    const bucket = byOption.get(l.optionId);
    const view: EstimateLineItemView = {
      id: l.id,
      pricebookItemId: l.pricebookItemId,
      name: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      // Cost is zeroed unless the caller is the admin detail read.
      costCents: includeCost ? l.costCents : 0,
      lineTotalCents: l.lineTotalCents,
    };
    if (bucket) bucket.push(view);
    else byOption.set(l.optionId, [view]);
  }

  return optionRows.map((o) => ({ ...o, lineItems: byOption.get(o.id) ?? [] }));
}

/** Admin detail view: estimate header + its options (each with line items). */
export async function getEstimateDetailById(
  organizationId: string,
  id: string,
): Promise<EstimateDetailView | null> {
  const [est] = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      totalCents: estimates.totalCents,
      customerId: estimates.customerId,
      serviceRequestId: estimates.serviceRequestId,
      soldOptionId: estimates.soldOptionId,
      signedAt: estimates.signedAt,
      signatureName: estimates.signatureName,
      expiresAt: estimates.expiresAt,
      createdAt: estimates.createdAt,
      dueDate: estimates.dueDate,
      fieldpulseEstimateId: estimates.fieldpulseEstimateId,
      fieldpulseStatusName: estimates.fieldpulseStatusName,
      title: estimates.title,
      fieldpulseData: estimates.fieldpulseData,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId, eq(estimates.id, id)))
    .limit(1);

  if (!est) return null;

  const { fieldpulseEstimateId, fieldpulseStatusName, fieldpulseData, ...header } = est;
  // Admin detail: include snapshotted cost so the UI can show margin.
  const options = await loadOptionsWithLineItems(organizationId, est.id, true);
  return {
    ...header,
    options,
    syncedSource: fieldpulseEstimateId != null ? "fieldpulse" : null,
    fieldpulseStatusName: fieldpulseStatusName ?? null,
    fieldpulseData: (fieldpulseData as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Admin "mark sold" path (e.g. a verbal acceptance), separate from the public
 * e-sign flow. Status-guarded: only an `open` estimate can be marked sold, and
 * the chosen option must belong to this estimate AND this org.
 */
export async function markEstimateSold(
  organizationId: string,
  id: string,
  optionId: string,
  now: Date = new Date(),
): Promise<ApproveEstimateResult> {
  const [est] = await db
    .select({ id: estimates.id, status: estimates.status, fieldpulseEstimateId: estimates.fieldpulseEstimateId })
    .from(estimates)
    .where(withTenant(estimates, organizationId, eq(estimates.id, id)))
    .limit(1);

  if (!est) return { ok: false, reason: "not_found" };
  if (est.fieldpulseEstimateId != null) return { ok: false, reason: "synced_read_only" };
  if (est.status !== "open") return { ok: false, reason: "already_decided" };

  const [opt] = await db
    .select({ id: estimateOptions.id })
    .from(estimateOptions)
    .where(
      withTenant(
        estimateOptions,
        organizationId,
        eq(estimateOptions.estimateId, est.id),
        eq(estimateOptions.id, optionId),
      ),
    )
    .limit(1);
  if (!opt) return { ok: false, reason: "invalid_option" };

  const [updated] = await db
    .update(estimates)
    .set({
      status: "sold",
      soldOptionId: optionId,
      signedAt: now,
      signatureName: "(admin)",
      updatedAt: now,
    })
    .where(
      withTenant(
        estimates,
        organizationId,
        eq(estimates.id, est.id),
        eq(estimates.status, "open"),
        isNull(estimates.fieldpulseEstimateId),
      ),
    )
    .returning({ id: estimates.id });

  if (!updated) return { ok: false, reason: "already_decided" };
  return { ok: true, estimateId: updated.id };
}

export interface EstimateForApproval {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly expiresAt: Date | null;
  readonly options: EstimateOptionView[];
}

/**
 * PUBLIC read for the e-sign page. Authorized BY THE TOKEN (no org filter on the
 * token lookup — the hashed token is the bearer of authority). Never returns the
 * token hash, signature IP, or any other estimate's data.
 */
export async function getEstimateForApproval(
  token: string,
): Promise<EstimateForApproval | null> {
  const [est] = await db
    .select({
      id: estimates.id,
      organizationId: estimates.organizationId,
      status: estimates.status,
      totalCents: estimates.totalCents,
      expiresAt: estimates.expiresAt,
    })
    .from(estimates)
    .where(eq(estimates.approvalTokenHash, hashToken(token)))
    .limit(1);

  if (!est) return null;

  // The token has already proven org membership; scope the option/line reads to
  // the resolved estimate's org for defense-in-depth.
  const options = await loadOptionsWithLineItems(est.organizationId, est.id);
  return {
    id: est.id,
    status: est.status,
    totalCents: est.totalCents,
    expiresAt: est.expiresAt,
    options,
  };
}
