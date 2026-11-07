/**
 * Idempotency for tech money POSTs (spec §4). A request claims
 * `(organization_id, user_id, route, key)` with its own attempt id; the winner
 * runs the work and stores the full response envelope (`done`) when the
 * outcome is deterministic, else releases the claim. Every write after the
 * claim is gated on the attempt id, so an attempt that was taken over matches
 * 0 rows and cannot overwrite the new owner. Losers replay, refuse a reused
 * key, report in-progress, take over a claim older than 2 minutes (same body
 * only) or re-claim a row that vanished.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { v5 as uuidv5 } from "uuid";
import { db } from "@/lib/db";
import { STORED_CODES } from "./idempotency-codes";

export const M3B_NAMESPACE = "6f1c6b3e-2a7d-4f0e-9c1d-3b8e5a2f7d41";
const TAKEOVER_AFTER_MS = 2 * 60_000;
const IN_PROGRESS_RETRY_AFTER_S = 2;

export interface KeyScope { organizationId: string; userId: string; route: string; key: string }

export type Envelope =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { message: string; code: string; details?: unknown } };
export type RunResult = { status: number; envelope: Envelope; retryAfter?: number };
export type KeyRow = {
  state: "in_progress" | "done";
  requestHash: string;
  responseStatus: number | null;
  responseBody: Envelope | null;
  createdAt: Date;
  attemptId: string;
};
export type Decision =
  | { kind: "replay"; status: number; envelope: Envelope }
  | { kind: "reused"; storedStatus: number | null }
  | { kind: "in_progress" }
  | { kind: "takeover" }
  | { kind: "reclaim" };

// ---------------------------------------------------------------- pure helpers

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseIdempotencyKey(header: string | null): string | null {
  return header !== null && KEY_RE.test(header) ? header : null;
}

/** Keys sorted recursively; undefined object values dropped (JSON semantics). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** The canonical JSON text: object keys sorted recursively, undefined dropped, arrays in order; null/undefined → "{}". */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value ?? {}));
}

/** sha256 hex of the canonical JSON; null/undefined/empty bodies hash "{}". */
export function canonicalHash(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

export function multipartHash(p: { route: string; requestId: string; fileSha256: string; name: string }): string {
  return canonicalHash({ route: p.route, requestId: p.requestId, fileSha256: p.fileSha256, name: p.name });
}

export function derivedIdInput(scope: KeyScope, n: string): string {
  return `${scope.organizationId}|${scope.userId}|${scope.route}|${scope.key}|${n}`;
}

export function derivedId(scope: KeyScope, n: string): string {
  return uuidv5(derivedIdInput(scope, n), M3B_NAMESPACE);
}

export function materialLineId(invoiceId: string, jobMaterialId: string): string {
  return uuidv5(`${invoiceId}|material|${jobMaterialId}`, M3B_NAMESPACE);
}

export function officeId(kind: "payment" | "refund" | "form", organizationId: string, clientToken: string): string {
  return uuidv5(`${organizationId}|${kind}|${clientToken}`, M3B_NAMESPACE);
}

export function decideReplay(row: KeyRow | null, hash: string, now: Date): Decision {
  if (row === null) return { kind: "reclaim" };
  if (row.requestHash !== hash) return { kind: "reused", storedStatus: row.responseStatus };
  if (row.state === "done" && row.responseStatus !== null && row.responseBody !== null) {
    return { kind: "replay", status: row.responseStatus, envelope: row.responseBody };
  }
  if (row.state === "done") return { kind: "in_progress" }; // unreachable by construction: done always stores both
  return now.getTime() - row.createdAt.getTime() < TAKEOVER_AFTER_MS ? { kind: "in_progress" } : { kind: "takeover" };
}

export function isStorable(status: number, envelope: Envelope): boolean {
  if (status >= 200 && status < 300) return true;
  return !envelope.success && STORED_CODES.has(envelope.error.code);
}

// ---------------------------------------------------------------- SQL builders

const pk = (s: KeyScope): SQL =>
  sql`organization_id = ${s.organizationId}::uuid AND user_id = ${s.userId}::uuid AND route = ${s.route} AND key = ${s.key}`;

export function claimSql(scope: KeyScope, hash: string, attemptId: string): SQL {
  return sql`INSERT INTO idempotency_keys (organization_id, user_id, route, key, request_hash, state, attempt_id)
    VALUES (${scope.organizationId}::uuid, ${scope.userId}::uuid, ${scope.route}, ${scope.key}, ${hash}, ${"in_progress"}, ${attemptId}::uuid)
    ON CONFLICT DO NOTHING RETURNING key`;
}

export function selectSql(scope: KeyScope): SQL {
  return sql`SELECT state, request_hash, response_status, response_body, created_at, attempt_id
    FROM idempotency_keys WHERE ${pk(scope)}`;
}

export function doneSql(scope: KeyScope, attemptId: string, status: number, envelope: Envelope): SQL {
  return sql`UPDATE idempotency_keys SET state = 'done', response_status = ${status}, response_body = ${JSON.stringify(envelope)}::jsonb
    WHERE ${pk(scope)} AND state = 'in_progress' AND attempt_id = ${attemptId}::uuid RETURNING key`;
}

export function deleteSql(scope: KeyScope, attemptId: string): SQL {
  return sql`DELETE FROM idempotency_keys WHERE ${pk(scope)} AND attempt_id = ${attemptId}::uuid RETURNING key`;
}

export function takeoverSql(scope: KeyScope, attemptId: string): SQL {
  return sql`UPDATE idempotency_keys SET created_at = now(), attempt_id = ${attemptId}::uuid
    WHERE ${pk(scope)} AND state = 'in_progress' AND created_at < now() - interval '2 minutes' RETURNING key`;
}

// ---------------------------------------------------------------- runner

type Rows = { rows: Record<string, unknown>[] };
const exec = async (q: SQL): Promise<Rows> => (await db.execute(q)) as unknown as Rows;

function toKeyRow(r: Record<string, unknown> | undefined): KeyRow | null {
  if (!r) return null;
  return {
    state: r.state === "done" ? "done" : "in_progress",
    requestHash: String(r.request_hash),
    responseStatus: r.response_status == null ? null : Number(r.response_status),
    responseBody: (r.response_body ?? null) as Envelope | null,
    createdAt: new Date(r.created_at as string | Date),
    attemptId: String(r.attempt_id),
  };
}

const inProgress = (): RunResult => ({
  status: 409,
  envelope: { success: false, error: { message: "Still saving your last tap. Try again in a moment.", code: "IN_PROGRESS" } },
  retryAfter: IN_PROGRESS_RETRY_AFTER_S,
});

const reused = (storedStatus: number | null): RunResult => ({
  status: 422,
  envelope: {
    success: false,
    error: { message: "That key was already used for a different request.", code: "IDEMPOTENCY_KEY_REUSED", details: { storedStatus } },
  },
});

/** Best-effort bookkeeping write: a failure is logged (code only) and never
 * replaces the winner's own result. */
async function bestEffort(q: SQL, what: "done" | "release"): Promise<void> {
  try {
    await exec(q);
  } catch (error) {
    console.error(`[idempotency] ${what}_failed`, (error as { code?: unknown })?.code ?? "unknown");
  }
}

type Run = (ids: { id: (n: string) => string }) => Promise<RunResult>;

async function runAsWinner(scope: KeyScope, attemptId: string, run: Run): Promise<RunResult & { replayed: boolean }> {
  let result: RunResult;
  try {
    result = await run({ id: (n) => derivedId(scope, n) });
  } catch (error) {
    await bestEffort(deleteSql(scope, attemptId), "release");
    throw error;
  }
  // A 0-row match means we were taken over meanwhile; our own result still stands.
  if (isStorable(result.status, result.envelope)) {
    await bestEffort(doneSql(scope, attemptId, result.status, result.envelope), "done");
  } else {
    await bestEffort(deleteSql(scope, attemptId), "release");
  }
  return { ...result, replayed: false };
}

const claim = async (scope: KeyScope, hash: string, attemptId: string) =>
  (await exec(claimSql(scope, hash, attemptId))).rows.length > 0;

const select = async (scope: KeyScope) => toKeyRow((await exec(selectSql(scope))).rows[0]);

/** Terminal decisions; anything that would loop (takeover, reclaim, in_progress) is 409. */
function settle(d: Decision): RunResult & { replayed: boolean } {
  if (d.kind === "replay") return { status: d.status, envelope: d.envelope, replayed: true };
  if (d.kind === "reused") return { ...reused(d.storedStatus), replayed: false };
  return { ...inProgress(), replayed: false };
}

export async function withIdempotency(scope: KeyScope, hash: string, run: Run): Promise<RunResult & { replayed: boolean }> {
  const attemptId = randomUUID();
  if (await claim(scope, hash, attemptId)) return runAsWinner(scope, attemptId, run);

  const decision = decideReplay(await select(scope), hash, new Date());
  if (decision.kind === "reclaim") {
    if (await claim(scope, hash, attemptId)) return runAsWinner(scope, attemptId, run);
    return { ...inProgress(), replayed: false };
  }
  if (decision.kind === "takeover") {
    if ((await exec(takeoverSql(scope, attemptId))).rows.length > 0) return runAsWinner(scope, attemptId, run);
    return settle(decideReplay(await select(scope), hash, new Date()));
  }
  return settle(decision);
}

export function toResponse(r: RunResult & { replayed?: boolean }): NextResponse {
  const body: Envelope =
    r.replayed && r.envelope.success ? { success: true, data: { ...r.envelope.data, replayed: true } } : r.envelope;
  const headers: Record<string, string> = r.retryAfter ? { "Retry-After": String(r.retryAfter) } : {};
  return NextResponse.json(body, { status: r.status, headers });
}
