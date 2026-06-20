import "server-only";

/**
 * Customer self-service portal — the customer-facing other half of the estimate
 * e-sign token. A tokenized, no-login surface where a customer views their
 * estimates, invoices, upcoming jobs, and service history, and pays an invoice
 * through the existing mock payment seam.
 *
 * SECURITY MODEL (this is the highest cross-tenant-leak surface — read carefully):
 *  - The portal token is CUSTOMER-scoped and long-lived. We store only its
 *    SHA-256 hash (like staff invites / estimate approval tokens); the plaintext
 *    is returned to the admin exactly ONCE at generation and is unrecoverable
 *    afterward. Rotating overwrites the hash (old links die instantly).
 *  - resolvePortalToken is the ONLY authority. Every read/write derives BOTH
 *    organizationId AND customerId FROM THE TOKEN ROW — never from a client
 *    param. Anything shown or paid is re-verified to belong to that token's
 *    (org, customer) via withTenant + an explicit customerId match.
 *  - Customer PII is AES-GCM encrypted per-column; decrypt SERVER-SIDE only.
 *  - Internal cost fields (costCents / margin / unitCostCents / serviceHistory
 *    cost) are NEVER selected into a portal payload. Customers must not see cost.
 */
import { randomBytes, createHash } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  invoices,
  estimates,
  serviceRequests,
  serviceHistory,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { takePayment, type TakePaymentResult } from "@/lib/admin/invoice-queries";

/** Random bytes in the token body (32 bytes -> 64 hex chars -> 256-bit). */
const TOKEN_BYTES = 32;

/** SHA-256 hex of a portal token. Deterministic, so a presented token can be
 * looked up by its (indexed, unique) hash. Mirrors hashInviteToken. */
function hashPortalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * ADMIN path: mint a fresh portal token for a customer, store ONLY its hash on
 * the customer row (rotate = overwrite), and return the plaintext ONCE. The
 * customer read is tenant-scoped, and the update is conditioned on both org and
 * id so a token can never be planted on another tenant's customer. Returns null
 * if the customer doesn't exist in this org.
 */
export async function generatePortalToken(
  organizationId: string,
  customerId: string,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .limit(1);
  if (!existing) return null;

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const [updated] = await db
    .update(customers)
    .set({
      portalTokenHash: hashPortalToken(token),
      portalTokenCreatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .returning({ id: customers.id });

  if (!updated) return null;
  return token;
}

/** Whether a customer currently has an active portal link (admin display). */
export async function getPortalTokenStatus(
  organizationId: string,
  customerId: string,
): Promise<{ active: boolean; createdAt: Date | null }> {
  const [row] = await db
    .select({
      portalTokenHash: customers.portalTokenHash,
      portalTokenCreatedAt: customers.portalTokenCreatedAt,
    })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .limit(1);
  return {
    active: Boolean(row?.portalTokenHash),
    createdAt: row?.portalTokenCreatedAt ?? null,
  };
}

/** ADMIN path: revoke a customer's portal link (clears the hash). */
export async function revokePortalToken(
  organizationId: string,
  customerId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(customers)
    .set({ portalTokenHash: null, portalTokenCreatedAt: null, updatedAt: new Date() })
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .returning({ id: customers.id });
  return Boolean(updated);
}

export interface PortalIdentity {
  readonly organizationId: string;
  readonly customerId: string;
}

/**
 * Resolve a plaintext portal token to its (org, customer). THIS is the only
 * authority for the entire portal — the hash is the bearer of identity. Returns
 * null for any unknown/revoked token. No org filter on the lookup (the hash is a
 * 256-bit secret, globally unique); the resolved org is then used to scope every
 * downstream read.
 */
export async function resolvePortalToken(
  token: string,
): Promise<PortalIdentity | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      organizationId: customers.organizationId,
      customerId: customers.id,
    })
    .from(customers)
    .where(eq(customers.portalTokenHash, hashPortalToken(token)))
    .limit(1);
  if (!row) return null;
  return { organizationId: row.organizationId, customerId: row.customerId };
}

// ---------------------------------------------------------------------------
// Portal payload — cost-free, customer-facing views. NO costCents / margin /
// unitCostCents anywhere in these shapes (the customer must never see cost).
// ---------------------------------------------------------------------------

export interface PortalInvoiceView {
  readonly id: string;
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  /** Remaining balance to pay (cents). Never negative. */
  readonly balanceCents: number;
  readonly createdAt: Date;
}

export interface PortalEstimateView {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly expiresAt: Date | null;
  /** True when this estimate is still open AND has a public approval token, i.e.
   * it is awaiting the customer's decision on the existing /estimates/[token]
   * e-sign page. The PLAINTEXT token is never stored (only its hash), so a usable
   * deep link cannot be reconstructed here — the admin shares the e-sign link
   * separately. We expose only this safe flag so the portal can show
   * "Awaiting your approval" without leaking the token or its hash. */
  readonly awaitingApproval: boolean;
}

export interface PortalJobView {
  readonly id: string;
  readonly status: string;
  readonly issueType: string;
  readonly scheduledDate: Date | null;
  readonly arrivalWindowStart: Date | null;
  readonly arrivalWindowEnd: Date | null;
}

export interface PortalHistoryView {
  readonly id: string;
  readonly workPerformed: string | null;
  readonly createdAt: Date;
}

export interface PortalData {
  readonly customerName: string | null;
  readonly invoices: PortalInvoiceView[];
  readonly estimates: PortalEstimateView[];
  readonly jobs: PortalJobView[];
  readonly history: PortalHistoryView[];
}

/** Jobs we consider "active" — shown as upcoming/in-progress in the portal. */
const ACTIVE_JOB_STATUSES = [
  "pending",
  "assigned",
  "scheduled",
  "in_progress",
  "on_hold",
] as const;

/**
 * Build the customer-facing dashboard for a resolved (org, customer). Every
 * query is tenant-scoped AND customer-scoped. The customer's display name is
 * decrypted server-side. NO cost/margin/internal fields are selected.
 */
export async function getPortalData(
  organizationId: string,
  customerId: string,
): Promise<PortalData> {
  const [custRow] = await db
    .select({ nameEncrypted: customers.nameEncrypted })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .limit(1);
  const customerName = safeDecrypt(custRow?.nameEncrypted ?? null);

  // Invoices — totals/paid/balance only; NO line items, NO costCents.
  const invoiceRows = await db
    .select({
      id: invoices.id,
      state: invoices.state,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.customerId, customerId)))
    .orderBy(desc(invoices.createdAt));

  // Estimates — status + headline total + (server-side) approval token so the
  // page can deep-link to the existing /estimates/[token] e-sign page. The token
  // hash is NOT returned; we only re-derive a usable link below if a hash exists.
  const estimateRows = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      totalCents: estimates.totalCents,
      expiresAt: estimates.expiresAt,
      approvalTokenHash: estimates.approvalTokenHash,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId, eq(estimates.customerId, customerId)))
    .orderBy(desc(estimates.createdAt));

  // Upcoming / active jobs — status + scheduling window. No internal fields.
  const jobRows = await db
    .select({
      id: serviceRequests.id,
      status: serviceRequests.status,
      issueType: serviceRequests.issueType,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.customerId, customerId),
        inArray(serviceRequests.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .orderBy(desc(serviceRequests.scheduledDate));

  // Basic service history — work performed + date. serviceHistory.cost is an
  // internal field and is DELIBERATELY NOT selected.
  const historyRows = await db
    .select({
      id: serviceHistory.id,
      workPerformed: serviceHistory.workPerformed,
      createdAt: serviceHistory.createdAt,
    })
    .from(serviceHistory)
    .where(
      withTenant(serviceHistory, organizationId, eq(serviceHistory.customerId, customerId)),
    )
    .orderBy(desc(serviceHistory.createdAt));

  return {
    customerName,
    invoices: invoiceRows.map((r) => ({
      id: r.id,
      state: r.state,
      totalCents: r.totalCents,
      amountPaidCents: r.amountPaidCents,
      balanceCents: Math.max(0, r.totalCents - r.amountPaidCents),
      createdAt: r.createdAt,
    })),
    estimates: estimateRows.map((r) => ({
      id: r.id,
      status: r.status,
      totalCents: r.totalCents,
      expiresAt: r.expiresAt,
      // Awaiting approval only if it's still open AND carries a public token.
      // We expose the boolean — never the hash — so no token material leaks.
      awaitingApproval: r.status === "open" && Boolean(r.approvalTokenHash),
    })),
    jobs: jobRows.map((r) => ({
      id: r.id,
      status: r.status,
      issueType: r.issueType,
      scheduledDate: r.scheduledDate,
      arrivalWindowStart: r.arrivalWindowStart,
      arrivalWindowEnd: r.arrivalWindowEnd,
    })),
    history: historyRows.map((r) => ({
      id: r.id,
      workPerformed: r.workPerformed,
      createdAt: r.createdAt,
    })),
  };
}

export type PortalPayResult =
  | { readonly ok: true; readonly invoiceState: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invoice_not_found"
        | "invoice_not_chargeable"
        | "exceeds_balance"
        | "charge_failed"
        // A Fieldpulse-synced invoice is billed in Fieldpulse — never payable here.
        | "synced_read_only";
    };

/**
 * Pay an invoice from the portal. RE-VERIFIES the invoice belongs to BOTH the
 * token's org AND the token's customer before charging (defense-in-depth: a
 * tampered invoiceId for another tenant — or another customer in the same org —
 * cannot pass). Then delegates the actual money movement to the existing
 * takePayment seam (NOT reimplemented here).
 */
export async function payPortalInvoice(
  organizationId: string,
  customerId: string,
  invoiceId: string,
  amountCents: number,
): Promise<PortalPayResult> {
  // Ownership gate: org + invoice id + customer id must ALL match.
  const [inv] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.id, invoiceId),
        eq(invoices.customerId, customerId),
      ),
    )
    .limit(1);
  if (!inv) return { ok: false, reason: "invoice_not_found" };

  const result: TakePaymentResult = await takePayment(organizationId, invoiceId, {
    amountCents,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, invoiceState: result.invoiceState };
}
