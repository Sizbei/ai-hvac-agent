/**
 * Who may fill a form, and when (M3d spec §5.1), as SQL for the writers and a
 * pure decision for the routes and GETs. Every table reference binds
 * organization_id; every fragment holding an OR is parenthesised. No db import.
 */
import { sql, type SQL } from "drizzle-orm";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";

const BILL_IN = statusInSql(BILL_STATUSES);

/** The caller holds a non-cancelled assignment on THAT live visit of the request. */
export function visitGateSql(org: string, rid: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id
    WHERE p.id = ${aid}::uuid AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND a.organization_id = ${org}::uuid
      AND p.cancelled_at IS NULL AND a.technician_id = ${me}::uuid AND a.status <> 'cancelled'::request_status)`;
}

/** The caller's own row on the visit has arrived / started / completed (the helper arm). */
function ownProgressSql(org: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments ga WHERE ga.appointment_id = ${aid}::uuid AND ga.organization_id = ${org}::uuid
      AND ga.technician_id = ${me}::uuid AND (ga.arrived_at IS NOT NULL OR ga.started_at IS NOT NULL OR ga.completed_at IS NOT NULL))`;
}

/**
 * The request is in the org and not cancelled; native: on site (BILL_STATUSES)
 * or the caller's own row has arrived; synced (FieldPulse or HCP): any status
 * but cancelled; and its customer is not erased.
 * Always AND with `visitGateSql`; `$aid` is not tied to `$rid` here.
 */
export function requestGateSql(org: string, rid: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM service_requests rg WHERE rg.id = ${rid}::uuid AND rg.organization_id = ${org}::uuid
      AND rg.status <> 'cancelled'::request_status
      AND ((rg.fieldpulse_job_id IS NOT NULL OR rg.hcp_job_id IS NOT NULL) OR rg.status IN ${BILL_IN} OR ${ownProgressSql(org, aid, me)})
      AND NOT EXISTS (SELECT 1 FROM customers gc WHERE gc.id = rg.customer_id AND gc.organization_id = ${org}::uuid AND gc.anonymized_at IS NOT NULL))`;
}

/** Empty job_type_ids = every request; a NULL job_type_id gets only those. Aliases are trusted literals. */
export function formAppliesSql(f: string, r: string): SQL {
  return sql.raw(`(cardinality(${f}.job_type_ids) = 0 OR ${r}.job_type_id = ANY(${f}.job_type_ids))`);
}

/** Pure twin of formAppliesSql. */
export function formApplies(jobTypeIds: readonly string[], jobTypeId: string | null): boolean {
  return jobTypeIds.length === 0 || (jobTypeId !== null && jobTypeIds.includes(jobTypeId));
}

/**
 * "Visit counts" (spec §5.1): live, or work progressed / completed on it, or it
 * holds a submission. Governs reads, submittedOn, links, missingRequired and
 * the office label; writes still need a live visit. `p` is the visit alias.
 */
export function visitCountsSql(org: string, p: string): SQL {
  const v = sql.raw(p);
  return sql`(${v}.cancelled_at IS NULL
    OR EXISTS (SELECT 1 FROM appointment_assignments vca WHERE vca.appointment_id = ${v}.id AND vca.organization_id = ${org}::uuid
      AND (vca.en_route_at IS NOT NULL OR vca.arrived_at IS NOT NULL OR vca.started_at IS NOT NULL OR vca.completed_at IS NOT NULL OR vca.status = 'completed'::request_status))
    OR EXISTS (SELECT 1 FROM form_submissions vcs WHERE vcs.appointment_id = ${v}.id AND vcs.organization_id = ${org}::uuid))`;
}

export interface VisitFacts {
  readonly cancelledAt: Date | string | null;
  readonly assignments: ReadonlyArray<{ readonly progressed: boolean; readonly status: string }>;
  readonly hasSubmission: boolean;
}

/** Pure twin of visitCountsSql. */
export function visitCounts(v: VisitFacts): boolean {
  return v.cancelledAt === null || v.hasSubmission || v.assignments.some((a) => a.progressed || a.status === "completed");
}

/** Everything the gate decisions read, in one row (spec §5.1). `formId` null reads no form. */
export function readFormGatesSql(org: string, rid: string, aid: string, me: string, formId: string | null): SQL {
  const mine = sql`SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = p.id AND a.organization_id = ${org}::uuid AND a.technician_id = ${me}::uuid`;
  return sql`SELECT r.status::text AS status,
      (r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL) AS native,
      EXISTS (SELECT 1 FROM customers c WHERE c.id = r.customer_id AND c.organization_id = ${org}::uuid AND c.anonymized_at IS NOT NULL) AS customer_erased,
      p.id IS NOT NULL AS visit_found,
      COALESCE(p.cancelled_at IS NULL, false) AS visit_live,
      EXISTS (${mine}) AS my_row,
      EXISTS (${mine} AND a.status <> 'cancelled'::request_status) AS my_live_row,
      EXISTS (${mine} AND (a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) AS my_progress,
      f.id IS NOT NULL AS form_found,
      COALESCE(f.active, false) AS form_active,
      f.version AS form_version
    FROM service_requests r
    LEFT JOIN appointments p ON p.id = ${aid}::uuid AND p.service_request_id = r.id AND p.organization_id = ${org}::uuid
    LEFT JOIN forms f ON f.id = ${formId}::uuid AND f.organization_id = ${org}::uuid
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export interface FormGates {
  readonly status: string;
  readonly native: boolean;
  readonly customerErased: boolean;
  readonly visitFound: boolean;
  readonly visitLive: boolean;
  readonly myRow: boolean;
  readonly myLiveRow: boolean;
  readonly myProgress: boolean;
  readonly formFound: boolean;
  readonly formActive: boolean;
  readonly formVersion: number | null;
}

export function toFormGates(row: Record<string, unknown> | undefined): FormGates | null {
  if (!row) return null;
  return {
    status: String(row.status),
    native: row.native === true,
    customerErased: row.customer_erased === true,
    visitFound: row.visit_found === true,
    visitLive: row.visit_live === true,
    myRow: row.my_row === true,
    myLiveRow: row.my_live_row === true,
    myProgress: row.my_progress === true,
    formFound: row.form_found === true,
    formActive: row.form_active === true,
    formVersion: row.form_version == null ? null : Number(row.form_version),
  };
}

export type GateReason = "not_found" | "job_closed" | "visit_ended" | "not_assigned" | "not_on_site" | "customer_removed";

/**
 * The first failing write gate, or null (lead ruling 1): a cancelled request
 * reads JOB_CLOSED before its (cancelled) visits and rows; an erased customer
 * refuses every write next, whoever and wherever (the GET's reason then matches
 * the refusal); an ended visit reads VISIT_ENDED to a technician who was on it,
 * NOT_ASSIGNED to anyone else.
 */
export function gateReason(g: FormGates | null): GateReason | null {
  if (!g || !g.visitFound) return "not_found";
  if (g.status === "cancelled") return "job_closed";
  if (g.customerErased) return "customer_removed";
  if (!g.visitLive) return g.myRow ? "visit_ended" : "not_assigned";
  if (!g.myLiveRow) return "not_assigned";
  if (g.native && !(BILL_STATUSES as readonly string[]).includes(g.status) && !g.myProgress) return "not_on_site";
  return null;
}

export type WriteBlockedReason =
  | "not_assigned" | "visit_ended" | "not_on_site" | "job_closed" | "archived"
  | "answers_removed" | "customer_removed" | "unreadable" | "submitted";

export interface RowFacts {
  readonly status: "draft" | "submitted";
  readonly erased: boolean;
  readonly unreadable: boolean;
}

/** The GET's `writeBlockedReason` (spec §6): null = the caller may write. */
export function writeBlockedReason(g: FormGates, row: RowFacts | null): WriteBlockedReason | null {
  if (g.status === "cancelled") return "job_closed";
  if (row?.erased) return "answers_removed";
  if (g.customerErased) return "customer_removed";
  if (row?.status === "submitted") return "submitted";
  if (row?.unreadable) return "unreadable";
  const gate = gateReason(g);
  if (gate === "visit_ended" || gate === "not_assigned" || gate === "not_on_site") return gate;
  if (gate === "not_found") return "not_assigned";
  if (row === null && !g.formActive) return "archived";
  return null;
}
