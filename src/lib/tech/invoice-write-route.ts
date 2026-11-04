/**
 * Plumbing shared by the tech invoice write routes (spec §6.1–§6.2): body
 * parsing, the idempotency-key header, the target-check refusal, success
 * envelopes and the best-effort audit (ids/enums only, never amounts or
 * check numbers).
 */
import type { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { parseIdempotencyKey, type RunResult } from "@/lib/http/idempotency";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";
import { reasonResult } from "@/lib/tech/invoice-errors";

type Parsed<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

export const invalidInput = (): NextResponse => errorResponse("That isn't a valid request.", "INVALID_INPUT", 400);

/** JSON body → schema. `emptyIsObject`: an absent or blank body reads as `{}` (create). */
export async function readWriteBody<S extends z.ZodType>(
  request: NextRequest, schema: S, emptyIsObject = false,
): Promise<Parsed<z.infer<S>>> {
  const text = await request.text();
  let raw: unknown;
  if (text.trim() === "") {
    if (!emptyIsObject) return { ok: false, response: invalidInput() };
    raw = {};
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: invalidInput() };
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: invalidInput() };
}

export function readKey(request: NextRequest): { ok: true; key: string } | { ok: false; response: NextResponse } {
  const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
  return key
    ? { ok: true, key }
    : { ok: false, response: errorResponse("Missing idempotency key.", "IDEMPOTENCY_KEY_REQUIRED", 400) };
}

/** A failed `resolveTarget` as the run's refusal. */
export const targetRefusal = (target: "stale" | "not_found"): RunResult =>
  reasonResult(target === "stale" ? "stale" : "invoice_not_found");

export const okResult = (status: number, data: Record<string, unknown>): RunResult =>
  ({ status, envelope: { success: true, data } });

/** Audit that never fails the write it records. */
export async function auditWrite(params: {
  organizationId: string; userId: string; action: string; entity: string; entityId: string; details: string;
}): Promise<void> {
  try {
    await logAudit(params);
  } catch (error) {
    logger.error({ error, action: params.action, entityId: params.entityId }, "Tech invoice audit failed");
  }
}
