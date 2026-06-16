/**
 * Stage 9 — estimates / good-better-best proposals.
 *
 * Line items are SNAPSHOTTED (name + price copied at quote time) so later
 * pricebook edits never mutate a sent quote. Approval is via a tokenized public
 * page (hashed token at rest, like staff invites) with typed-name e-signature +
 * IP/timestamp capture.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  estimateOptions,
  estimateLineItems,
} from "@/lib/db/schema";
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
  | { readonly ok: false; readonly reason: "not_found" | "expired" | "already_decided" | "invalid_option" };

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
    .where(and(eq(estimates.id, est.id), eq(estimates.status, "open")))
    .returning({ id: estimates.id });

  if (!updated) return { ok: false, reason: "already_decided" };
  return { ok: true, estimateId: updated.id };
}
