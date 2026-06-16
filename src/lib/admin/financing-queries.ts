/**
 * Stage 9 — consumer financing on estimates / invoices.
 *
 * A thin hand-off to the FinancingProvider seam (mock until a lender contract +
 * WISETACK_API_KEY exist). We create an application, the lender owns underwriting
 * and reports status back via webhook. We NEVER quote APR / monthly payment /
 * Reg-Z terms — the provider owns terms; we surface only its applyUrl + status.
 *
 * Schema note: financing_applications links to estimate_id / customer_id only
 * (NO invoice_id, NO apply_url columns). An invoice-initiated application is
 * stored against the invoice's underlying estimate, and applyUrl is DERIVED from
 * providerAppId (not stored). See deriveApplyUrl + the column-gap note in the
 * task report.
 */
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { financingApplications, invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import {
  getFinancingProvider,
  type FinancingProvider,
} from "@/lib/financing/provider";

type FinancingStatus = "pending" | "approved" | "declined" | "expired";

export interface FinancingApplicationView {
  readonly id: string;
  readonly status: FinancingStatus;
  /** Lender prequalification link the customer opens. Derived, not stored. */
  readonly applyUrl: string;
  readonly requestedAmountCents: number;
  readonly estimateId: string | null;
  readonly customerId: string | null;
  readonly providerAppId: string | null;
}

/**
 * Derive the lender apply URL from the provider app id. The table does not store
 * applyUrl; for the mock the URL is deterministic from providerAppId. A real
 * adapter that returns opaque URLs will need an apply_url column (reported gap).
 */
function deriveApplyUrl(providerAppId: string | null): string {
  if (!providerAppId) return "";
  return `https://example.test/financing/${providerAppId}`;
}

function toView(row: {
  id: string;
  status: FinancingStatus;
  requestedAmountCents: number;
  estimateId: string | null;
  customerId: string | null;
  providerAppId: string | null;
}): FinancingApplicationView {
  return {
    id: row.id,
    status: row.status,
    requestedAmountCents: row.requestedAmountCents,
    estimateId: row.estimateId,
    customerId: row.customerId,
    providerAppId: row.providerAppId,
    applyUrl: deriveApplyUrl(row.providerAppId),
  };
}

export type CreateFinancingResult =
  | { readonly ok: true; readonly application: FinancingApplicationView }
  | { readonly ok: false; readonly reason: "invoice_not_found" | "no_estimate_link" };

const APPLICATION_COLUMNS = {
  id: financingApplications.id,
  status: financingApplications.status,
  requestedAmountCents: financingApplications.requestedAmountCents,
  estimateId: financingApplications.estimateId,
  customerId: financingApplications.customerId,
  providerAppId: financingApplications.providerAppId,
} as const;

/**
 * Create (or return the existing) financing application for an estimate or
 * invoice. Idempotent: a second call for the same estimate/invoice returns the
 * existing application without calling the provider again.
 *
 * An invoice-initiated application is resolved to the invoice's underlying
 * estimate (the table has no invoice_id). An invoice with no estimate link can't
 * be financed via this path (reported as no_estimate_link).
 *
 * The provider is injectable for tests.
 */
export async function createFinancingApplication(
  organizationId: string,
  params: {
    readonly invoiceId?: string;
    readonly estimateId?: string;
    readonly customerId?: string;
    readonly requestedAmountCents: number;
  },
  provider: FinancingProvider = getFinancingProvider(),
): Promise<CreateFinancingResult> {
  // Resolve the estimate + customer to link against. For invoice-initiated
  // applications we read the invoice (tenant-scoped) to find its estimate.
  let estimateId = params.estimateId ?? null;
  let customerId = params.customerId ?? null;
  // Idempotency key: invoice id if invoice-initiated, else estimate id. A
  // double-click yields the same key so the provider dedupes the application.
  const idempotencyKey = params.invoiceId ?? params.estimateId;

  if (params.invoiceId) {
    const [inv] = await db
      .select({
        estimateId: invoices.estimateId,
        customerId: invoices.customerId,
      })
      .from(invoices)
      .where(withTenant(invoices, organizationId, eq(invoices.id, params.invoiceId)))
      .limit(1);
    if (!inv) return { ok: false, reason: "invoice_not_found" };
    if (!inv.estimateId) return { ok: false, reason: "no_estimate_link" };
    estimateId = inv.estimateId;
    customerId = customerId ?? inv.customerId;
  }

  if (!idempotencyKey || !estimateId) {
    // No estimate to key/link on — the caller must supply estimateId or an
    // invoice that links to one.
    return { ok: false, reason: "no_estimate_link" };
  }

  // Idempotency: one application per estimate. Return the existing one rather
  // than creating a duplicate (also covers the concurrent double-click).
  const [existing] = await db
    .select(APPLICATION_COLUMNS)
    .from(financingApplications)
    .where(
      withTenant(
        financingApplications,
        organizationId,
        eq(financingApplications.estimateId, estimateId),
      ),
    )
    .limit(1);
  if (existing) {
    return { ok: true, application: toView(existing) };
  }

  const result = await provider.createApplication({
    requestedAmountCents: params.requestedAmountCents,
    idempotencyKey,
  });

  const id = randomUUID();
  await db.insert(financingApplications).values({
    id,
    organizationId,
    estimateId,
    customerId,
    provider: provider.name,
    providerAppId: result.providerAppId,
    status: result.status,
    requestedAmountCents: params.requestedAmountCents,
    approvedAmountCents: result.approvedAmountCents ?? null,
  });

  return {
    ok: true,
    application: {
      id,
      status: result.status,
      requestedAmountCents: params.requestedAmountCents,
      estimateId,
      customerId,
      providerAppId: result.providerAppId,
      // Prefer the provider's own applyUrl (real adapters return opaque URLs);
      // the stored row can only derive it from providerAppId on re-read.
      applyUrl: result.applyUrl,
    },
  };
}

/**
 * List financing applications for display, tenant-scoped. Filter by estimate, by
 * the invoice's underlying estimate, or by customer. Newest first.
 */
export async function listFinancingApplications(
  organizationId: string,
  params: {
    readonly invoiceId?: string;
    readonly estimateId?: string;
    readonly customerId?: string;
  },
): Promise<FinancingApplicationView[]> {
  let estimateId = params.estimateId ?? null;

  if (params.invoiceId) {
    const [inv] = await db
      .select({ estimateId: invoices.estimateId })
      .from(invoices)
      .where(withTenant(invoices, organizationId, eq(invoices.id, params.invoiceId)))
      .limit(1);
    // An unknown invoice (or one with no estimate) has no applications to show.
    if (!inv || !inv.estimateId) return [];
    estimateId = inv.estimateId;
  }

  const filter = estimateId
    ? eq(financingApplications.estimateId, estimateId)
    : params.customerId
      ? eq(financingApplications.customerId, params.customerId)
      : null;
  if (!filter) return [];

  const rows = await db
    .select(APPLICATION_COLUMNS)
    .from(financingApplications)
    .where(withTenant(financingApplications, organizationId, filter))
    .orderBy(desc(financingApplications.createdAt));

  return rows.map(toView);
}

export type UpdateFinancingStatusResult =
  | { readonly ok: true; readonly outcome: "updated" | "noop" }
  | { readonly ok: false; readonly reason: "not_found" };

/** Terminal statuses can't be moved again (the lender's last word stands). */
const TERMINAL_STATUSES: ReadonlySet<FinancingStatus> = new Set([
  "approved",
  "declined",
  "expired",
]);

/**
 * Mirror a lender status callback onto the local application, tenant-scoped and
 * idempotent: only a 'pending' application advances to a terminal status; an
 * already-terminal application is a no-op (never regressed). Looked up by
 * providerAppId.
 */
export async function updateFinancingStatusByProviderId(
  organizationId: string,
  providerAppId: string,
  status: FinancingStatus,
): Promise<UpdateFinancingStatusResult> {
  const [row] = await db
    .select({ id: financingApplications.id, status: financingApplications.status })
    .from(financingApplications)
    .where(
      withTenant(
        financingApplications,
        organizationId,
        eq(financingApplications.providerAppId, providerAppId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };

  // Idempotent: don't regress a terminal status, and no-op if unchanged.
  if (TERMINAL_STATUSES.has(row.status as FinancingStatus) || row.status === status) {
    return { ok: true, outcome: "noop" };
  }

  await db
    .update(financingApplications)
    .set({ status, updatedAt: new Date() })
    .where(
      withTenant(
        financingApplications,
        organizationId,
        eq(financingApplications.id, row.id),
      ),
    );

  return { ok: true, outcome: "updated" };
}
