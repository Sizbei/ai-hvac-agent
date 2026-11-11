/**
 * FieldPulse estimate status → native estimate status. PURE module (no db or
 * server imports) so the importer, the backfill script and the tests share it.
 *
 * What FieldPulse actually sends (live-verified 2026-11-11, company 182499):
 *  - `status` is always the number 1 on estimates. It is not the estimate's
 *    stage, so it is never mapped.
 *  - `estimate_status` (0–8) is a legacy code that FieldPulse no longer keeps
 *    in step with the workflow: 40 live estimates carry code 0 or 4 next to
 *    status_id 2225541 "Declined / Expired". It is never mapped either.
 *  - `status_id` is the estimate's place in the company's own status workflow.
 *    GET /estimates/status-workflows lists every workflow with its statuses;
 *    each status has a company name ("Sent", "Declined / Expired") and a fixed
 *    FieldPulse bucket `type` (estimate_draft, estimate_sent, estimate_accepted,
 *    estimate_rejected, estimate_lost, estimate_completed, estimate_any, …).
 *  - `estimate_accept_at` is the moment the customer accepted. Every
 *    "Accepted" estimate has it; no "Draft", "Sent", "Rejected" or
 *    "Declined / Expired" estimate does.
 *
 * Mapping (the bucket type decides, never the company's label):
 *  - estimate_rejected / estimate_lost → "dismissed". FieldPulse's lost bucket
 *    here is named "Declined / Expired", which cannot tell the two apart, so it
 *    is not mapped to "expired".
 *  - estimate_accepted, or any status with `estimate_accept_at` set → "sold".
 *    The customer's recorded acceptance is the only evidence used for "sold".
 *  - everything else (draft, sent, completed without an acceptance, the
 *    company's own steps like "Scheduled") → "open", with the FieldPulse name
 *    kept so the screen shows what FieldPulse shows.
 */

export type NativeEstimateStatus = "open" | "sold" | "dismissed" | "expired";

export interface FpEstimateStatusEntry {
  readonly name: string;
  readonly type: string | null;
}

/** status_id → company name + FieldPulse bucket type. */
export type FpEstimateStatusLookup = ReadonlyMap<string, FpEstimateStatusEntry>;

const DISMISSED_TYPES = new Set(["estimate_rejected", "estimate_lost"]);
const ACCEPTED_TYPE = "estimate_accepted";

function idString(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * Build the status lookup from the raw `response` array of
 * GET /estimates/status-workflows. Malformed entries are skipped; a status that
 * appears in several workflows is the same row, so the first copy wins.
 */
export function buildFpEstimateStatusLookup(workflows: unknown): FpEstimateStatusLookup {
  const out = new Map<string, FpEstimateStatusEntry>();
  if (!Array.isArray(workflows)) return out;
  for (const wf of workflows) {
    if (typeof wf !== "object" || wf === null) continue;
    const statuses = (wf as Record<string, unknown>).statuses;
    if (!Array.isArray(statuses)) continue;
    for (const s of statuses) {
      if (typeof s !== "object" || s === null) continue;
      const row = s as Record<string, unknown>;
      const id = idString(row.id);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!id || !name || out.has(id)) continue;
      out.set(id, { name, type: typeof row.type === "string" ? row.type : null });
    }
  }
  return out;
}

export interface FpEstimateStatusInput {
  /** FieldPulse status_id (number or string). */
  readonly statusId: unknown;
  /** FieldPulse estimate_accept_at; any non-empty value counts as accepted. */
  readonly acceptedAt: unknown;
}

export interface ResolvedFpEstimateStatus {
  readonly status: NativeEstimateStatus;
  /** The company's FieldPulse status name, or null when the id is unknown. */
  readonly name: string | null;
}

export function resolveFpEstimateStatus(
  input: FpEstimateStatusInput,
  lookup: FpEstimateStatusLookup,
): ResolvedFpEstimateStatus {
  const id = idString(input.statusId);
  const entry = id ? lookup.get(id) : undefined;
  const name = entry?.name ?? null;
  const type = entry?.type ?? null;
  const accepted =
    (typeof input.acceptedAt === "string" && input.acceptedAt.trim() !== "") ||
    (typeof input.acceptedAt === "number" && Number.isFinite(input.acceptedAt));

  if (type && DISMISSED_TYPES.has(type)) return { status: "dismissed", name };
  if (type === ACCEPTED_TYPE || accepted) return { status: "sold", name };
  return { status: "open", name };
}

/** What a sync or backfill may write over a stored estimate's status. */
export interface FpEstimateStatusUpdate {
  readonly status: NativeEstimateStatus;
  /** Present only when FieldPulse named the status; absent = keep the stored name. */
  readonly name?: string;
}

/**
 * The status change FieldPulse evidence supports, or null to keep the stored
 * status and name. Null when the workflows could not be read or came back
 * empty (an empty lookup is a failed lookup, not "every id is unknown"), and
 * when the status id is in no current workflow and nothing records an
 * acceptance. An unknown id with a recorded acceptance moves to "sold" but
 * keeps the stored name.
 */
export function fpEstimateStatusUpdate(
  input: FpEstimateStatusInput,
  lookup: FpEstimateStatusLookup | null,
): FpEstimateStatusUpdate | null {
  if (!lookup || lookup.size === 0) return null;
  const resolved = resolveFpEstimateStatus(input, lookup);
  if (resolved.name !== null) return { status: resolved.status, name: resolved.name };
  return resolved.status === "sold" ? { status: "sold" } : null;
}
