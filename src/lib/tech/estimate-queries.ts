/**
 * GET /api/tech/jobs/[id]/estimates read model (M3c spec §6). Small org-scoped
 * raw reads; no cost column and no signature_name is ever selected.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { ERASED_PLACEHOLDER } from "@/lib/admin/report-format";
import { errorCode, logger } from "@/lib/logger";
import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";
import { billingInvoiceIdSql, jobBilledSql, officeBilledSql } from "@/lib/admin/estimate-billing-sql";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
import { billingOf, createBlockedReason, derivedStatus, estimateLabel } from "@/lib/tech/estimate-display";
import type { TechEstimate, TechEstimateOption, TechEstimatesView, TechJobInvoiceRef } from "@/lib/tech/estimate-view";

type Row = Record<string, unknown>;
const E = sql.raw("e.id");
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

async function rows(q: SQL): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}

export function estimatesSql(org: string, rid: string, me: string): SQL {
  return sql`SELECT e.id, e.status::text AS status, e.created_at, e.expires_at, e.signed_at, e.sold_option_id, e.sold_via,
      (e.sold_by IS NOT NULL AND e.sold_by = ${me}::uuid) AS sold_by_me,
      (e.approval_token_hash IS NOT NULL) AS has_approval_link,
      ${officeBilledSql(org, E)} AS office_billed, ${jobBilledSql(org, E)} AS job_billed,
      ${billingInvoiceIdSql(org, E)} AS billing_invoice_id
    FROM estimates e
    WHERE e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid AND e.fieldpulse_estimate_id IS NULL
    ORDER BY e.created_at DESC, e.id DESC`;
}

export function optionsSql(org: string, rid: string): SQL {
  return sql`SELECT o.id, o.estimate_id, o.name, o.sort_order, o.subtotal_cents, o.tax_cents, o.total_cents
    FROM estimate_options o JOIN estimates e ON e.id = o.estimate_id
    WHERE o.organization_id = ${org}::uuid AND e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid
      AND e.fieldpulse_estimate_id IS NULL
    ORDER BY o.sort_order, o.id`;
}

export function linesSql(org: string, rid: string): SQL {
  return sql`SELECT l.id, l.option_id, l.pricebook_item_id, l.name, l.quantity, l.unit_price_cents, l.line_total_cents
    FROM estimate_line_items l JOIN estimate_options o ON o.id = l.option_id JOIN estimates e ON e.id = o.estimate_id
    WHERE l.organization_id = ${org}::uuid AND o.organization_id = ${org}::uuid AND e.organization_id = ${org}::uuid
      AND e.service_request_id = ${rid}::uuid AND e.fieldpulse_estimate_id IS NULL
    ORDER BY l.id`;
}

export function jobInvoiceSql(org: string, rid: string): SQL {
  return sql`SELECT id, state::text AS state, amount_paid_cents > 0 AS has_payment
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid AND ${P_LIVE} AND ${P_NATIVE}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
}

export function priorPaidSql(org: string, rid: string): SQL {
  return sql`SELECT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
    AND state IN ('paid'::invoice_state, 'refunded'::invoice_state) AND ${P_NATIVE}) AS paid`;
}

export function assembleEstimates(estRows: readonly Row[], optRows: readonly Row[], lineRows: readonly Row[], now: Date): TechEstimate[] {
  const linesByOption = new Map<string, TechEstimateOption["lines"][number][]>();
  for (const l of lineRows) {
    const key = String(l.option_id);
    const list = linesByOption.get(key) ?? [];
    list.push({
      id: String(l.id), pricebookItemId: str(l.pricebook_item_id), name: String(l.name), quantity: Number(l.quantity),
      unitPriceCents: Number(l.unit_price_cents), lineTotalCents: Number(l.line_total_cents),
    });
    linesByOption.set(key, list);
  }
  const optionsByEstimate = new Map<string, TechEstimateOption[]>();
  for (const o of optRows) {
    const key = String(o.estimate_id);
    const list = optionsByEstimate.get(key) ?? [];
    list.push({
      id: String(o.id), name: String(o.name), sortOrder: Number(o.sort_order), subtotalCents: Number(o.subtotal_cents),
      taxCents: Number(o.tax_cents), totalCents: Number(o.total_cents), lines: linesByOption.get(String(o.id)) ?? [],
    });
    optionsByEstimate.set(key, list);
  }
  return estRows.map((e) => {
    const options = optionsByEstimate.get(String(e.id)) ?? [];
    return {
      id: String(e.id),
      label: estimateLabel(e.created_at as string | Date, options.length),
      status: derivedStatus(String(e.status), (e.expires_at as string | Date | null) ?? null, now),
      createdAt: iso(e.created_at) ?? "",
      expiresAt: iso(e.expires_at),
      signedAt: iso(e.signed_at),
      soldOptionId: str(e.sold_option_id),
      soldVia: str(e.sold_via),
      soldByMe: e.sold_by_me === true,
      hasApprovalLink: e.has_approval_link === true,
      billing: billingOf(e.office_billed === true, e.job_billed === true),
      billingInvoiceId: str(e.billing_invoice_id),
      options,
    };
  });
}

async function companyNameOf(org: string): Promise<string | null> {
  try {
    return (await getOrgConfig(org)).companyName ?? null;
  } catch (error) {
    logger.warn({ code: errorCode(error), organizationId: org }, "Estimate view: company name read failed; showing none");
    return null;
  }
}

/** The name the customer view greets; an erased customer reads as no name ("Your estimate"). */
export function shownCustomerName(plain: string): string | null {
  const name = plain.trim();
  return name === "" || name === ERASED_PLACEHOLDER ? null : name;
}

async function customerNameOf(org: string, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await rows(sql`SELECT name_encrypted FROM customers WHERE id = ${customerId}::uuid AND organization_id = ${org}::uuid`);
  if (!row?.name_encrypted) return null;
  try {
    return shownCustomerName(decrypt(String(row.name_encrypted)));
  } catch (error) {
    logger.warn({ code: errorCode(error), organizationId: org, customerId }, "Estimate view: customer name decrypt failed; showing none");
    return null;
  }
}

export async function getTechEstimatesView(
  org: string, me: string, rid: string, now: Date = new Date(),
): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEstimatesView }> {
  const job = await findReadableJob(org, me, rid);
  if (!job) return { kind: "not_found" };
  if (!job.native) return { kind: "external" };
  const [visit, estRows, optRows, lineRows, invRows, priorRows, taxBps, companyName, customerDisplayName] = await Promise.all([
    findActiveVisit(org, rid),
    rows(estimatesSql(org, rid, me)),
    rows(optionsSql(org, rid)),
    rows(linesSql(org, rid)),
    rows(jobInvoiceSql(org, rid)),
    rows(priorPaidSql(org, rid)),
    getDefaultTaxBps(org),
    companyNameOf(org),
    customerNameOf(org, job.customerId),
  ]);
  const isLead = visit?.leadTechnicianId === me;
  const reason = createBlockedReason({ isLead, status: job.status, hasCustomer: job.customerId !== null });
  const estimates = assembleEstimates(estRows, optRows, lineRows, now);
  const inv = invRows[0];
  const jobInvoice: TechJobInvoiceRef | null = inv
    ? { id: String(inv.id), state: inv.state === "open" ? "open" : "draft", hasPayment: inv.has_payment === true }
    : null;
  return {
    kind: "ok",
    view: {
      companyName, customerDisplayName, isLead, canCreate: reason === null, createBlockedReason: reason, taxBps,
      requestStatus: job.status, hasOtherSold: estimates.some((e) => e.status === "sold"), jobInvoice,
      priorInvoicePaid: priorRows[0]?.paid === true, estimates,
    },
  };
}
