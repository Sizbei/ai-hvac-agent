/**
 * The field invoice screen's read model (spec §6.2.1, §5.1). One function,
 * `getTechInvoiceView`, assembled from small org-scoped raw reads. Cost
 * columns (`cost_cents`, `unit_cost_cents`, `markup_pct`) are never selected,
 * so they cannot reach a technician. Helpers (non-leads) get the invoice
 * reduced to id/state/total/balance and nothing else.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
import { MATERIAL_NAME, P_LIVE, P_NATIVE, materialBilledSql } from "@/lib/admin/invoice-field-writes";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
import { invoiceAllowedActions } from "@/lib/tech/invoice-actions";
import { getStorageClient } from "@/lib/storage/r2-client";
import { storageKeyFromPublicUrl } from "@/lib/storage/storage-key";
import type {
  TechInvoice, TechInvoiceHistory, TechInvoiceLine, TechInvoicePayment, TechInvoiceSignature,
  TechInvoiceState, TechInvoiceView, TechOtherOpenInvoice, TechUnbilledMaterial,
} from "@/lib/tech/invoice-view";

type Row = Record<string, unknown>;

const ON_SITE: readonly string[] = ["arrived", "in_progress", "on_hold", "completed"];
const SIGNED_URL_TTL_SECONDS = 15 * 60;

const NONE: TechInvoiceSignature = { state: "none", signedAt: null, signatureName: null, url: null, fresh: false };

async function rows(q: SQL): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

// ---------------------------------------------------------------- reads

/** The request's signature, whether an FP/HCP invoice exists, and a pending tech write on this job. */
function metaSql(org: string, rid: string, me: string): SQL {
  return sql`SELECT r.signature_url, r.signature_name, r.signed_at,
      EXISTS (SELECT 1 FROM invoices i WHERE i.organization_id = ${org}::uuid AND i.service_request_id = ${rid}::uuid
        AND (i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL)) AS external_invoice,
      EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.organization_id = ${org}::uuid AND k.user_id = ${me}::uuid
        AND k.route LIKE '/api/tech/jobs/' || ${rid}::text || '/%' AND k.state = 'in_progress'
        AND k.created_at > now() - interval '2 minutes') AS pending_write
    FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

/** THE invoice (spec §5.1 adopt rule): the newest live native invoice of the request. */
function adoptedSql(org: string, rid: string): SQL {
  return sql`SELECT id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents,
      GREATEST(0, total_cents - amount_paid_cents) AS balance_cents, issued_at, updated_at, created_at,
      estimate_id, customer_id, signature_url, signature_name, signed_at
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid AND ${P_LIVE} AND ${P_NATIVE}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
}

function otherOpenSql(org: string, rid: string, adoptedId: string): SQL {
  return sql`SELECT id, total_cents, GREATEST(0, total_cents - amount_paid_cents) AS balance_cents
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
      AND state = 'open'::invoice_state AND ${P_NATIVE} AND id <> ${adoptedId}::uuid
    ORDER BY created_at DESC, id DESC`;
}

/** With no live invoice: the newest settled (paid/refunded) native invoice, shown in full (paid-view ruling). */
function settledSql(org: string, rid: string): SQL {
  return sql`SELECT id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents,
      GREATEST(0, total_cents - amount_paid_cents) AS balance_cents, issued_at, updated_at, created_at,
      estimate_id, customer_id, signature_url, signature_name, signed_at
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
      AND state IN ('paid'::invoice_state, 'refunded'::invoice_state) AND ${P_NATIVE}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
}

function historySql(org: string, rid: string): SQL {
  return sql`SELECT id, state, total_cents
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
      AND state IN ('paid'::invoice_state, 'refunded'::invoice_state, 'void'::invoice_state) AND ${P_NATIVE}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
}

function linesSql(org: string, inv: string): SQL {
  return sql`SELECT id, name, quantity, unit_price_cents, line_total_cents
    FROM invoice_line_items WHERE invoice_id = ${inv}::uuid AND organization_id = ${org}::uuid
    ORDER BY created_at, id`;
}

function paymentsSql(org: string, inv: string): SQL {
  return sql`SELECT id, method, check_number, amount_cents, status, created_at
    FROM payments WHERE invoice_id = ${inv}::uuid AND organization_id = ${org}::uuid
    ORDER BY created_at DESC, id DESC`;
}

/** Unbilled materials captured after the draft was created (a deleted seeded line does not come back). */
function unbilledMaterialsSql(org: string, rid: string, inv: string): SQL {
  return sql`SELECT m.id, ${MATERIAL_NAME} AS name, m.quantity, m.unit_price_cents
    FROM job_materials m LEFT JOIN pricebook_items pi ON pi.id = m.pricebook_item_id AND pi.organization_id = ${org}::uuid
    WHERE m.service_request_id = ${rid}::uuid AND m.organization_id = ${org}::uuid
      AND m.created_at > (SELECT i0.created_at FROM invoices i0 WHERE i0.id = ${inv}::uuid AND i0.organization_id = ${org}::uuid)
      AND NOT ${materialBilledSql(org, rid, sql.raw("m.id"))}
    ORDER BY m.created_at, m.id`;
}

function estimateSql(org: string, estimateId: string): SQL {
  return sql`SELECT signed_at, signature_name FROM estimates WHERE id = ${estimateId}::uuid AND organization_id = ${org}::uuid`;
}

function customerPhoneSql(org: string, customerId: string): SQL {
  return sql`SELECT phone_encrypted IS NOT NULL AS has_phone FROM customers WHERE id = ${customerId}::uuid AND organization_id = ${org}::uuid`;
}

// ---------------------------------------------------------------- signature

async function signedUrl(publicUrl: string): Promise<string | null> {
  try {
    const key = storageKeyFromPublicUrl(publicUrl);
    if (!key) return null;
    return await getStorageClient().getSignedReadUrl(key, SIGNED_URL_TTL_SECONDS);
  } catch {
    return null; // no R2 env (the constructor throws) or signing failed
  }
}

/** present / erased / unavailable / none from a (url, name, signedAt) triple. */
async function fromColumns(url: unknown, name: unknown, signedAt: unknown, fresh: boolean): Promise<TechInvoiceSignature> {
  if (signedAt === null || signedAt === undefined) return NONE;
  const base = { signedAt: iso(signedAt), signatureName: str(name), fresh };
  if (url === null || url === undefined) return { ...base, state: "erased", url: null };
  const signed = await signedUrl(String(url));
  return signed ? { ...base, state: "present", url: signed } : { ...base, state: "unavailable", url: null };
}

async function signatureOf(org: string, inv: Row, meta: Row): Promise<TechInvoiceSignature> {
  if (inv.estimate_id && !inv.signed_at) {
    const [est] = await rows(estimateSql(org, String(inv.estimate_id)));
    if (!est?.signed_at) return NONE;
    return { state: "estimate", signedAt: iso(est.signed_at), signatureName: str(est.signature_name), url: null, fresh: false };
  }
  if (inv.state === "draft") {
    const fresh = meta.signed_at != null
      && new Date(meta.signed_at as string).getTime() >= new Date(inv.updated_at as string).getTime();
    return fromColumns(meta.signature_url, meta.signature_name, meta.signed_at, fresh);
  }
  return fromColumns(inv.signature_url, inv.signature_name, inv.signed_at, false);
}

// ---------------------------------------------------------------- the lead's full invoice

async function fullInvoice(org: string, rid: string, inv: Row, meta: Row): Promise<{
  invoice: TechInvoice; materials: TechUnbilledMaterial[];
}> {
  const id = String(inv.id);
  const draft = inv.state === "draft";
  const [lineRows, paymentRows, materialRows, taxBps, signature] = await Promise.all([
    rows(linesSql(org, id)),
    rows(paymentsSql(org, id)),
    draft ? rows(unbilledMaterialsSql(org, rid, id)) : Promise.resolve([] as Row[]),
    draft ? getDefaultTaxBps(org) : Promise.resolve(null),
    signatureOf(org, inv, meta),
  ]);
  const lines: TechInvoiceLine[] = lineRows.map((l) => ({
    id: String(l.id), name: String(l.name), quantity: num(l.quantity),
    unitPriceCents: num(l.unit_price_cents), lineTotalCents: num(l.line_total_cents),
  }));
  const payments: TechInvoicePayment[] = paymentRows.map((p) => ({
    id: String(p.id), method: String(p.method), checkNumber: str(p.check_number),
    amountCents: num(p.amount_cents), status: String(p.status), createdAt: iso(p.created_at),
  }));
  const materials: TechUnbilledMaterial[] = materialRows.map((m) => ({
    id: String(m.id), name: String(m.name), quantity: num(m.quantity), unitPriceCents: num(m.unit_price_cents),
  }));
  return {
    invoice: {
      id, state: inv.state as TechInvoiceState,
      subtotalCents: num(inv.subtotal_cents), taxCents: num(inv.tax_cents), taxBps,
      totalCents: num(inv.total_cents), amountPaidCents: num(inv.amount_paid_cents), balanceCents: num(inv.balance_cents),
      issuedAt: iso(inv.issued_at), updatedAt: iso(inv.updated_at), fromEstimate: Boolean(inv.estimate_id),
      lines, payments, signature,
    },
    materials,
  };
}

// ---------------------------------------------------------------- the view

/**
 * Ids of the request's job materials that sit on a non-void native invoice
 * (the job page's "Not on an invoice" chip reads the complement).
 */
export async function billedMaterialIds(org: string, rid: string): Promise<ReadonlySet<string>> {
  const found = await rows(sql`SELECT m.id FROM job_materials m
    WHERE m.service_request_id = ${rid}::uuid AND m.organization_id = ${org}::uuid
      AND ${materialBilledSql(org, rid, sql.raw("m.id"))}`);
  return new Set(found.map((r) => String(r.id)));
}

export type TechInvoiceViewResult =
  | { kind: "not_found" }
  | { kind: "external" }
  | { kind: "ok"; view: TechInvoiceView };

/** not_found = not readable by this technician; external = a FieldPulse/HCP job (spec §6.1, 409). */
export async function getTechInvoiceView(
  organizationId: string,
  techUserId: string,
  requestId: string,
): Promise<TechInvoiceViewResult> {
  const org = organizationId;
  const rid = requestId;
  const job = await findReadableJob(org, techUserId, rid);
  if (!job) return { kind: "not_found" };
  if (!job.native) return { kind: "external" };
  return { kind: "ok", view: await buildView(org, techUserId, rid, job) };
}

async function buildView(
  org: string,
  techUserId: string,
  rid: string,
  job: { customerId: string | null; native: boolean; status: string },
): Promise<TechInvoiceView> {

  const [visit, [live], [meta]] = await Promise.all([
    findActiveVisit(org, rid),
    rows(adoptedSql(org, rid)),
    rows(metaSql(org, rid, techUserId)),
  ]);
  const isLead = visit?.leadTechnicianId === techUserId;
  const onSite = ON_SITE.includes(job.status);
  const m: Row = meta ?? {};
  // No live invoice: the newest paid/refunded one is THE invoice, in full; history
  // is only a void-only request's last voided invoice.
  const [settled] = live ? [] : await rows(settledSql(org, rid));
  const adopted: Row | undefined = live ?? settled;
  // The invoice's own customer once one exists (pay link refuses a null invoice customer, §6.4).
  const customerId = adopted ? str(adopted.customer_id) : job.customerId;

  const [otherRows, historyRows, phoneRows] = await Promise.all([
    live ? rows(otherOpenSql(org, rid, String(live.id))) : Promise.resolve([] as Row[]),
    adopted ? Promise.resolve([] as Row[]) : rows(historySql(org, rid)),
    customerId ? rows(customerPhoneSql(org, customerId)) : Promise.resolve([] as Row[]),
  ]);
  const otherOpen: TechOtherOpenInvoice[] = otherRows.map((r) => ({
    id: String(r.id), totalCents: num(r.total_cents), balanceCents: num(r.balance_cents),
  }));
  const h = historyRows[0];
  const history: TechInvoiceHistory | null = h
    ? { id: String(h.id), state: h.state as TechInvoiceHistory["state"], totalCents: num(h.total_cents) }
    : null;
  const shared = {
    otherOpen, history,
    pendingWrite: Boolean(m.pending_write),
    customerHasPhone: Boolean(phoneRows[0]?.has_phone),
    isLead, onSite,
    externalInvoice: Boolean(m.external_invoice),
  };

  if (!isLead) {
    const invoice = adopted
      ? { id: String(adopted.id), state: adopted.state as TechInvoiceState, totalCents: num(adopted.total_cents), balanceCents: num(adopted.balance_cents) }
      : null;
    return { invoice, ...shared, materialsNotOnInvoice: [], allowed: [] };
  }

  const full = adopted ? await fullInvoice(org, rid, adopted, m) : null;
  const allowed = invoiceAllowedActions({
    state: full ? full.invoice.state : "none",
    isLead, onSite, native: job.native, externalInvoice: shared.externalInvoice,
    balanceCents: full?.invoice.balanceCents ?? 0,
    lines: full?.invoice.lines.length ?? 0,
    fromEstimate: full?.invoice.fromEstimate ?? false,
    customerHasPhone: shared.customerHasPhone,
    signatureFresh: full?.invoice.signature.fresh ?? false,
  });
  return { invoice: full?.invoice ?? null, ...shared, materialsNotOnInvoice: full?.materials ?? [], allowed };
}
