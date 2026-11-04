/**
 * Shared gates for the tech invoice WRITE routes (spec §6.1) and the target
 * check every write runs inside its idempotency `run` (spec §6.2). Each gate
 * short-circuits before the next one is evaluated.
 */
import type { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTechSession } from "@/lib/auth/tech-session";
import type { TechSessionPayload } from "@/lib/auth/tech-config";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";

export type ReadableJob = NonNullable<Awaited<ReturnType<typeof findReadableJob>>>;

export type PreambleResult =
  | { ok: true; session: TechSessionPayload; job: ReadableJob; requestId: string }
  | { ok: false; response: NextResponse };

const ON_SITE: readonly string[] = ["arrived", "in_progress", "on_hold", "completed"];

const fail = (message: string, code: string, status: number): PreambleResult =>
  ({ ok: false, response: errorResponse(message, code, status) });

export async function techWritePreamble(request: NextRequest, id: string): Promise<PreambleResult> {
  const session = await getTechSession();
  if (!session) return fail("Unauthorized", "UNAUTHORIZED", 401);
  if (!isSameOriginRequest(request)) return fail("Forbidden", "FORBIDDEN", 403);
  if (!isUuid(id)) return fail("Invalid request ID format", "INVALID_ID", 400);
  const rate = slidingWindow(
    `tech:invoice:write:${session.userId}`,
    RATE_LIMITS.adminMutation.maxRequests,
    RATE_LIMITS.adminMutation.windowMs,
  );
  if (!rate.allowed) return fail("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);

  const job = await findReadableJob(session.organizationId, session.userId, id);
  if (!job) return fail("This job isn't yours.", "NOT_FOUND", 404);
  if (!job.native) return fail("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
  const visit = await findActiveVisit(session.organizationId, id);
  if (!visit || visit.leadTechnicianId !== session.userId) {
    return fail("Only the lead technician can do that.", "NOT_LEAD", 403);
  }
  if (!ON_SITE.includes(job.status)) return fail("Arrive at the job before invoicing.", "NOT_ON_SITE", 409);
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
  if (mode === "newest") {
    const { rows } = await db.execute(sql`SELECT id FROM invoices
      WHERE organization_id = ${organizationId}::uuid AND service_request_id = ${requestId}::uuid AND ${P_LIVE} AND ${P_NATIVE}
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    return (rows[0] as { id?: string } | undefined)?.id === invoiceId ? "ok" : "stale";
  }
  const { rows } = await db.execute(sql`SELECT id FROM invoices
    WHERE id = ${invoiceId}::uuid AND organization_id = ${organizationId}::uuid AND service_request_id = ${requestId}::uuid
      AND state <> 'void'::invoice_state AND ${P_NATIVE}`);
  return rows.length > 0 ? "ok" : "not_found";
}
