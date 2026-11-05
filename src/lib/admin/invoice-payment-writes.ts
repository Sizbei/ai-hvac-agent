/**
 * Manual payment and manual refund writers (spec §5.5, §5.6). Same rules as
 * `./invoice-field-writes`: ONE db.batch per write (neon-http: one transaction),
 * lock-first L_req → L_inv → payment row, xmin/EXISTS gates, every enum literal
 * cast, outcomes read from the batch's own final SELECTs.
 *
 * Both writers read the by-id row FIRST (global by id — the documented
 * exception; the ids are org-scoped uuidv5 derivations): a row matching every
 * field replays `created: false`, a differing row is an id conflict — before any
 * native/state/balance check, so a retry after a full-balance payment replays
 * instead of `invoice_not_chargeable`.
 */
import { sql, type SQL } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  lockInvoiceSql, lockRequestSql, P_NATIVE, readRows, runBatch, stillLeadSql, type Actor, type FieldReason,
} from "./invoice-field-writes";

type Row = Record<string, unknown>;

/** A positive whole number of cents; anything else is refused before any read. */
const validCents = (n: number): boolean => Number.isInteger(n) && n >= 1;

const XMIN = sql.raw("xmin = pg_current_xact_id()::xid");
const nullable = (v: unknown): unknown => v ?? null;
const invoiceStateSql = (org: string, inv: string): SQL =>
  sql`SELECT state FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid`;

// ---------------------------------------------------------------- payment

type PaymentInput = { method: "cash" | "check" | "other"; amountCents: number; checkNumber?: string; isDeposit: boolean; recordedBy: string };
type PaymentResult = { ok: true; paymentId: string; invoiceState: string; created: boolean } | { ok: false; reason: FieldReason };

const paymentByIdSql = (pid: string): SQL =>
  sql`SELECT id, invoice_id, amount_cents, method, check_number, is_deposit FROM payments WHERE id = ${pid}::uuid`;

/** The five replay fields; check_number null-safe. */
function samePayment(row: Row, inv: string, input: PaymentInput): boolean {
  return row.invoice_id === inv && Number(row.amount_cents) === input.amountCents && row.method === input.method
    && nullable(row.check_number) === nullable(input.checkNumber) && row.is_deposit === input.isDeposit;
}

export async function recordManualPayment(
  actor: Actor, invoiceId: string, ids: { paymentId: string }, input: PaymentInput,
): Promise<PaymentResult> {
  const { organizationId: org } = actor;
  const { paymentId: pid } = ids;
  const amt = input.amountCents;
  if (!validCents(amt)) return { ok: false, reason: "exceeds_balance" };
  const tech = actor.techUserId !== null;
  if (tech && actor.requestId === null) throw new Error("recordManualPayment: a technician actor needs a requestId");

  // 1. By-id row first.
  const [prior] = await readRows(paymentByIdSql(pid));
  if (prior) {
    if (!samePayment(prior, invoiceId, input)) return { ok: false, reason: "payment_id_conflict" };
    const [inv] = await readRows(invoiceStateSql(org, invoiceId));
    if (!inv) return { ok: false, reason: "invoice_not_found" };
    return { ok: true, paymentId: pid, invoiceState: inv.state as string, created: false };
  }

  // 2. Preconditions.
  const ridPred = tech ? sql`service_request_id = ${actor.requestId}::uuid` : sql.raw("TRUE");
  const [pre] = await readRows(sql`SELECT service_request_id, state, total_cents, amount_paid_cents,
      (fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL) AS synced
    FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid${tech ? sql` AND ${ridPred}` : sql``}`);
  if (!pre) return { ok: false, reason: "invoice_not_found" };
  if (pre.synced === true) return { ok: false, reason: "synced_read_only" };
  if (pre.state !== "open") return { ok: false, reason: "invoice_not_chargeable" };
  if (amt > Number(pre.total_cents) - Number(pre.amount_paid_cents)) return { ok: false, reason: "exceeds_balance" };

  // 3. The batch.
  const rid = tech ? actor.requestId : ((pre.service_request_id as string | null) ?? null);
  const lead = tech ? stillLeadSql(org, actor.requestId!, actor.techUserId!) : null;
  const items: SQL[] = [
    ...(rid !== null ? [lockRequestSql(org, rid)] : []),
    lockInvoiceSql(org, invoiceId),
    sql`UPDATE invoices SET amount_paid_cents = amount_paid_cents + ${amt}::int, updated_at = now()
      WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND (${ridPred}) AND state = 'open'::invoice_state AND ${P_NATIVE}
        AND amount_paid_cents + ${amt}::int <= total_cents
        AND NOT EXISTS (SELECT 1 FROM payments WHERE id = ${pid}::uuid)
        AND (${lead ?? sql.raw("TRUE")})
      RETURNING amount_paid_cents, total_cents`,
    sql`INSERT INTO payments (id, organization_id, invoice_id, provider, provider_payment_id, amount_cents, status, is_deposit, method, check_number, recorded_by)
      SELECT ${pid}::uuid, ${org}::uuid, ${invoiceId}::uuid, 'manual', NULL, ${amt}::int, 'succeeded'::payment_status, ${input.isDeposit}::boolean,
        ${input.method}::text, ${input.checkNumber ?? null}::text, ${input.recordedBy}::uuid
      WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${XMIN})
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    sql`UPDATE invoices SET state = (CASE WHEN amount_paid_cents >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state, updated_at = now()
      WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid
        AND EXISTS (SELECT 1 FROM payments WHERE id = ${pid}::uuid AND ${XMIN})
      RETURNING state`,
    paymentByIdSql(pid),
    invoiceStateSql(org, invoiceId),
    ...(lead ? [sql`SELECT (${lead}) AS still_lead`] : []),
  ];
  const rows = await runBatch(items);
  if (!Array.isArray(rows)) return rows;

  const at = rid !== null ? 2 : 1;
  const [claim, inserted, , payRows, invRows] = rows.slice(at);
  const state = invRows![0]?.state as string | undefined;
  if (claim!.length > 0) {
    if (inserted!.length === 0) {
      logger.error({ organizationId: org, invoiceId, paymentId: pid }, "recordManualPayment invariant: invoice credited without a payment row");
    }
    return { ok: true, paymentId: pid, invoiceState: state ?? "open", created: true };
  }
  const row = payRows![0];
  if (row) {
    if (!samePayment(row, invoiceId, input)) return { ok: false, reason: "payment_id_conflict" };
    return { ok: true, paymentId: pid, invoiceState: state ?? "open", created: false };
  }
  if (lead && rows[rows.length - 1]![0]?.still_lead !== true) return { ok: false, reason: "not_lead" };
  if (state === undefined) return { ok: false, reason: "invoice_not_found" };
  return { ok: false, reason: state === "open" ? "exceeds_balance" : "invoice_not_chargeable" };
}

// ---------------------------------------------------------------- refund

type RefundReason = "payment_not_found" | "not_refundable" | "exceeds_payment" | "refund_id_conflict" | "stale";
type RefundResult = { ok: true; refundId: string; created: boolean } | { ok: false; reason: RefundReason };

const refundByIdSql = (refundId: string): SQL =>
  sql`SELECT payment_id, amount_cents, reason FROM refunds WHERE id = ${refundId}::uuid`;

function sameRefund(row: Row, pid: string, input: { amountCents: number; reason?: string }): boolean {
  return row.payment_id === pid && Number(row.amount_cents) === input.amountCents && nullable(row.reason) === nullable(input.reason);
}

export async function refundManualPayment(
  organizationId: string, paymentId: string, ids: { refundId: string }, input: { amountCents: number; reason?: string },
): Promise<RefundResult> {
  const org = organizationId;
  const pid = paymentId;
  const { refundId } = ids;
  const amt = input.amountCents;
  if (!validCents(amt)) return { ok: false, reason: "exceeds_payment" };

  // 1. By-id row first.
  const [prior] = await readRows(refundByIdSql(refundId));
  if (prior) {
    return sameRefund(prior, pid, input) ? { ok: true, refundId, created: false } : { ok: false, reason: "refund_id_conflict" };
  }

  // 2. Preconditions.
  const [pay] = await readRows(sql`SELECT p.invoice_id, p.provider, p.status, p.amount_cents, p.amount_refunded_cents, i.service_request_id
    FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.organization_id = ${org}::uuid
    WHERE p.id = ${pid}::uuid AND p.organization_id = ${org}::uuid`);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  if (pay.provider !== "manual" || pay.status !== "succeeded") return { ok: false, reason: "not_refundable" };
  if (amt > Number(pay.amount_cents) - Number(pay.amount_refunded_cents)) return { ok: false, reason: "exceeds_payment" };

  // 3. The batch.
  const inv = pay.invoice_id as string;
  const rid = (pay.service_request_id as string | null) ?? null;
  const items: SQL[] = [
    ...(rid !== null ? [lockRequestSql(org, rid)] : []),
    lockInvoiceSql(org, inv),
    sql`SELECT 1 FROM payments WHERE id = ${pid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`,
    sql`UPDATE payments SET amount_refunded_cents = amount_refunded_cents + ${amt}::int,
        status = (CASE WHEN amount_refunded_cents + ${amt}::int >= amount_cents THEN 'refunded' ELSE 'succeeded' END)::payment_status,
        updated_at = now()
      WHERE id = ${pid}::uuid AND organization_id = ${org}::uuid AND provider = 'manual' AND status = 'succeeded'::payment_status
        AND amount_refunded_cents + ${amt}::int <= amount_cents
        AND NOT EXISTS (SELECT 1 FROM refunds WHERE id = ${refundId}::uuid)
      RETURNING id`,
    sql`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, provider_refund_id)
      SELECT ${refundId}::uuid, ${org}::uuid, ${pid}::uuid, ${amt}::int, ${input.reason ?? null}::text, NULL
      WHERE EXISTS (SELECT 1 FROM payments WHERE id = ${pid}::uuid AND organization_id = ${org}::uuid AND ${XMIN})
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    sql`UPDATE invoices SET amount_paid_cents = GREATEST(0, amount_paid_cents - ${amt}::int),
        state = (CASE WHEN GREATEST(0, amount_paid_cents - ${amt}::int) >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state,
        updated_at = now()
      WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid
        AND EXISTS (SELECT 1 FROM refunds WHERE id = ${refundId}::uuid AND ${XMIN})`,
    refundByIdSql(refundId),
    invoiceStateSql(org, inv),
    sql`SELECT status FROM payments WHERE id = ${pid}::uuid AND organization_id = ${org}::uuid`,
  ];
  const rows = await runBatch(items);
  if (!Array.isArray(rows)) return { ok: false, reason: "stale" };

  const at = rid !== null ? 3 : 2;
  const [claim, inserted, , refRows, , statusRows] = rows.slice(at);
  if (claim!.length > 0) {
    if (inserted!.length === 0) {
      logger.error({ organizationId: org, paymentId: pid, refundId }, "refundManualPayment invariant: payment claimed without a refund row");
    }
    return { ok: true, refundId, created: true };
  }
  const row = refRows![0];
  if (row) return sameRefund(row, pid, input) ? { ok: true, refundId, created: false } : { ok: false, reason: "refund_id_conflict" };
  return { ok: false, reason: statusRows![0]?.status === "succeeded" ? "exceeds_payment" : "not_refundable" };
}
