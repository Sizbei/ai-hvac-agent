/**
 * Shared gates for the tech WRITE routes — invoice (M3b §6.1), estimate and
 * bill (M3c §6), equipment (M3c §5.6) — and the invoice target check every
 * invoice write runs inside its idempotency `run` (M3b §6.2). Each gate
 * short-circuits before the next one is evaluated.
 */
import type { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTechSession } from "@/lib/auth/tech-session";
import { rateKeyFor } from "@/lib/tech/tech-preview";
import type { TechSessionPayload } from "@/lib/auth/tech-config";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";
import { findActiveVisit, findReadableJob, findTechAssignments } from "@/lib/tech/ownership";
import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";

export type ReadableJob = NonNullable<Awaited<ReturnType<typeof findReadableJob>>>;

export type PreambleResult =
  | { ok: true; session: TechSessionPayload; job: ReadableJob; requestId: string }
  | { ok: false; response: NextResponse };

export interface PreambleOptions {
  /** Rate-limit bucket: `tech:<bucket>:write:<user>`. */
  readonly bucket: string;
  /** Request statuses the write accepts. */
  readonly statuses: readonly string[];
  /** 409 NOT_ON_SITE copy (pending / assigned / scheduled / en_route). */
  readonly beforeCopy: string;
  /** 409 JOB_CLOSED copy (completed / cancelled not in `statuses`). */
  readonly closedCopy: string;
}

export const INVOICE_PREAMBLE: PreambleOptions = {
  bucket: "invoice", statuses: BILL_STATUSES,
  beforeCopy: "Arrive at the job before invoicing.", closedCopy: "Arrive at the job before invoicing.",
};
export const ESTIMATE_PREAMBLE: PreambleOptions = {
  bucket: "estimate", statuses: SELL_STATUSES, beforeCopy: "Arrive at the job first.", closedCopy: "This job is closed.",
};
export const BILL_PREAMBLE: PreambleOptions = { ...ESTIMATE_PREAMBLE, statuses: BILL_STATUSES };
export const EQUIPMENT_PREAMBLE: PreambleOptions = { ...ESTIMATE_PREAMBLE, bucket: "equipment", statuses: BILL_STATUSES };

export function statusRefusal(
  status: string, opts: PreambleOptions,
): { code: "NOT_ON_SITE" | "JOB_CLOSED"; message: string } | null {
  const gate = statusGate(status, opts.statuses);
  if (gate === "ok") return null;
  return gate === "job_closed" ? { code: "JOB_CLOSED", message: opts.closedCopy } : { code: "NOT_ON_SITE", message: opts.beforeCopy };
}

const fail = (message: string, code: string, status: number) =>
  ({ ok: false as const, response: errorResponse(message, code, status) });

/** session → same-origin → uuid → rate limit (`limit` defaults to the 30/min write limit; M3d draft autosave passes 60/min). */
export async function frontGates(
  request: NextRequest, id: string, bucket: string,
  limit: { readonly maxRequests: number; readonly windowMs: number } = RATE_LIMITS.adminMutation,
): Promise<{ ok: true; session: TechSessionPayload } | { ok: false; response: NextResponse }> {
  const session = await getTechSession();
  if (!session) return fail("Unauthorized", "UNAUTHORIZED", 401);
  if (!isSameOriginRequest(request)) return fail("Forbidden", "FORBIDDEN", 403);
  if (!isUuid(id)) return fail("Invalid request ID format", "INVALID_ID", 400);
  const rate = slidingWindow(`tech:${bucket}:write:${rateKeyFor(session)}`, limit.maxRequests, limit.windowMs);
  if (!rate.allowed) return fail("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
  return { ok: true, session };
}

/** Lead-only writes: front gates → readable job 404 → native 409 → active lead 403 → status 409. */
export async function techWritePreamble(
  request: NextRequest, id: string, opts: PreambleOptions = INVOICE_PREAMBLE,
): Promise<PreambleResult> {
  const front = await frontGates(request, id, opts.bucket);
  if (!front.ok) return front;
  const { session } = front;
  const job = await findReadableJob(session.organizationId, session.userId, id);
  if (!job) return fail("This job isn't yours.", "NOT_FOUND", 404);
  if (!job.native) return fail("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
  const visit = await findActiveVisit(session.organizationId, id);
  if (!visit || visit.leadTechnicianId !== session.userId) return fail("Only the lead technician can do that.", "NOT_LEAD", 403);
  const refusal = statusRefusal(job.status, opts);
  if (refusal) return fail(refusal.message, refusal.code, 409);
  return { ok: true, session, job, requestId: id };
}

/** Equipment writes (any technician working the job): front gates → readable job → native → a non-cancelled assignment → status. */
export async function techEquipmentPreamble(request: NextRequest, id: string): Promise<PreambleResult> {
  const front = await frontGates(request, id, EQUIPMENT_PREAMBLE.bucket);
  if (!front.ok) return front;
  const { session } = front;
  const job = await findReadableJob(session.organizationId, session.userId, id);
  if (!job) return fail("This job isn't yours.", "NOT_FOUND", 404);
  if (!job.native) return fail("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
  const mine = await findTechAssignments(session.organizationId, session.userId, id);
  if (!mine.some((r) => r.status !== "cancelled")) {
    return fail("Only a technician working this job can do that.", "NOT_ASSIGNED", 403);
  }
  const refusal = statusRefusal(job.status, EQUIPMENT_PREAMBLE);
  if (refusal) return fail(refusal.message, refusal.code, 409);
  return { ok: true, session, job, requestId: id };
}

/**
 * "newest": the invoice must be the request's newest live native invoice
 * (lines, finalize) — else "stale" (voided by the office, or a newer one).
 * "any": any non-void native invoice of the request (payments, pay link).
 */
export async function resolveTarget(
  organizationId: string,
  requestId: string,
  invoiceId: string,
  mode: "newest" | "any",
): Promise<"ok" | "stale" | "not_found"> {
  const target = invoiceId.toLowerCase(); // Postgres returns lowercase uuids
  if (mode === "newest") {
    const { rows } = await db.execute(sql`SELECT id FROM invoices
      WHERE organization_id = ${organizationId}::uuid AND service_request_id = ${requestId}::uuid AND ${P_LIVE} AND ${P_NATIVE}
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    return (rows[0] as { id?: string } | undefined)?.id === target ? "ok" : "stale";
  }
  const { rows } = await db.execute(sql`SELECT id FROM invoices
    WHERE id = ${target}::uuid AND organization_id = ${organizationId}::uuid AND service_request_id = ${requestId}::uuid
      AND state <> 'void'::invoice_state AND ${P_NATIVE}`);
  return rows.length > 0 ? "ok" : "not_found";
}
