/**
 * The Site page read (M3d spec §7.6). Anchored on the readable request: the
 * customer, location and address come from service_requests server-side;
 * every table binds organization_id. Never the customer's jobs at another
 * address, never a guessed address; no description, notes, addresses, contact
 * fields or signature names leave this module.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { normalizeAddress } from "@/lib/admin/location-queries";
import { decrypt } from "@/lib/crypto";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { findActiveVisit, findReadableJob, isActiveLead } from "@/lib/tech/ownership";
import { issueLabel } from "@/lib/tech/job-display";
import { estimateLabel } from "@/lib/tech/estimate-display";
import { membershipEvaluable, siteMatches, siteScopeOf, type SiteCandidate, type SiteSelf } from "@/lib/forms/site-scope";
import type { SiteEstimate, SiteMembership, SitePastJob, SiteView } from "@/lib/tech/site-view";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const CANDIDATE_CAP = 500;
const PAST_JOBS_CAP = 20;

/** Decrypt then normalise; a blob under a rotated key reads as "no address" (never throws). */
export function normalizedAddress(enc: unknown): string | null {
  if (typeof enc !== "string" || enc === "") return null;
  try {
    const n = normalizeAddress(decrypt(enc));
    return n === "" ? null : n;
  } catch {
    return null;
  }
}

export function siteSelfSql(org: string, rid: string): SQL {
  return sql`SELECT r.customer_id, r.location_id, r.address_encrypted, c.anonymized_at IS NOT NULL AS customer_erased, l.label AS location_label
    FROM service_requests r
    LEFT JOIN customers c ON c.id = r.customer_id AND c.organization_id = ${org}::uuid
    LEFT JOIN customer_locations l ON l.id = r.location_id AND l.organization_id = ${org}::uuid
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export function candidatesSql(org: string, cust: string, rid: string): SQL {
  return sql`SELECT id, location_id, address_encrypted FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND id <> ${rid}::uuid AND status <> 'cancelled'::request_status
    ORDER BY created_at DESC, id LIMIT ${CANDIDATE_CAP}`;
}

export function pastJobsSql(org: string, ids: readonly string[]): SQL {
  return sql`SELECT r.id, r.reference_number, COALESCE(r.completed_at, r.scheduled_date, r.created_at) AS job_date, r.status::text AS status,
      jt.name AS job_type_name, r.issue_type, split_part(u.name, ' ', 1) AS lead_first_name,
      ARRAY(SELECT DISTINCT s.form_name FROM form_submissions s WHERE s.organization_id = ${org}::uuid AND s.service_request_id = r.id
        AND s.status = 'submitted' ORDER BY s.form_name LIMIT 3) AS form_names
    FROM service_requests r
    LEFT JOIN job_types jt ON jt.id = r.job_type_id AND jt.organization_id = ${org}::uuid
    LEFT JOIN users u ON u.id = r.assigned_to AND u.organization_id = ${org}::uuid
    WHERE r.organization_id = ${org}::uuid AND r.id = ANY(${uuidArraySql(ids)})
      AND NOT (r.status IN ('pending'::request_status, 'assigned'::request_status, 'scheduled'::request_status)
        AND COALESCE(r.scheduled_date, r.arrival_window_start) > now())
    ORDER BY COALESCE(r.completed_at, r.scheduled_date, r.created_at) DESC, r.id LIMIT ${PAST_JOBS_CAP}`;
}

export function unaddressedSql(org: string, cust: string, rid: string): SQL {
  return sql`SELECT count(*)::int AS n FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND id <> ${rid}::uuid AND status <> 'cancelled'::request_status
      AND address_encrypted IS NULL AND location_id IS NULL`;
}

export function openEstimatesSql(org: string, requestIds: readonly string[]): SQL {
  return sql`SELECT e.id, e.created_at, e.total_cents, e.title, e.fieldpulse_estimate_id IS NOT NULL AS from_fp, e.service_request_id,
      (SELECT count(*)::int FROM estimate_options o WHERE o.estimate_id = e.id AND o.organization_id = ${org}::uuid) AS option_count
    FROM estimates e
    WHERE e.organization_id = ${org}::uuid AND e.status = 'open'::estimate_status AND (e.expires_at IS NULL OR e.expires_at > now())
      AND e.service_request_id = ANY(${uuidArraySql(requestIds)})
    ORDER BY e.created_at DESC, e.id`;
}

/** Every non-cancelled request of the customer, no cap (membership needs all of them). */
export function allAddressesSql(org: string, cust: string): SQL {
  return sql`SELECT address_encrypted FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND status <> 'cancelled'::request_status`;
}

export function membershipSql(org: string, cust: string): SQL {
  return sql`SELECT m.id, m.started_at, m.current_period_end, pl.name AS plan_name, pl.visits_per_year
    FROM customer_memberships m JOIN membership_plans pl ON pl.id = m.plan_id AND pl.organization_id = ${org}::uuid
    WHERE m.organization_id = ${org}::uuid AND m.customer_id = ${cust}::uuid AND m.status = 'active'::membership_status
    ORDER BY m.started_at DESC LIMIT 1`;
}

/** Up to 3 scheduled / generated visits due from the start of today in the business timezone. */
export function upcomingVisitsSql(org: string, membershipId: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): SQL {
  return sql`SELECT due_date, status::text AS status, generated_service_request_id FROM membership_visits
    WHERE organization_id = ${org}::uuid AND customer_membership_id = ${membershipId}::uuid
      AND status IN ('scheduled'::membership_visit_status, 'generated'::membership_visit_status)
      AND due_date >= (date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})
    ORDER BY due_date, id LIMIT 3`;
}

async function readMembership(org: string, cust: string, rid: string, selfAddress: string | null): Promise<SiteMembership> {
  if (selfAddress === null) return { state: "withheld" };
  const [[locs], all] = await Promise.all([
    readRows(sql`SELECT count(*)::int AS n FROM customer_locations WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid`),
    readRows(allAddressesSql(org, cust)),
  ]);
  if (!membershipEvaluable(selfAddress, Number(locs?.n ?? 0), all.map((r) => normalizedAddress(r.address_encrypted)))) {
    return { state: "withheld" };
  }
  const [m] = await readRows(membershipSql(org, cust));
  if (!m) return { state: "none" };
  const upcoming = await readRows(upcomingVisitsSql(org, String(m.id)));
  return {
    state: "member",
    planName: String(m.plan_name),
    startedAt: iso(m.started_at),
    currentPeriodEnd: m.current_period_end == null ? null : iso(m.current_period_end),
    visitsPerYear: Number(m.visits_per_year),
    upcoming: upcoming.map((v) => ({
      dueDate: iso(v.due_date),
      status: v.status === "generated" ? "generated" : "scheduled",
      thisJob: String(v.generated_service_request_id ?? "") === rid,
    })),
  };
}

function toPastJob(r: Row): SitePastJob {
  return {
    id: String(r.id),
    referenceNumber: String(r.reference_number),
    date: iso(r.job_date),
    status: String(r.status),
    kind: r.job_type_name ? String(r.job_type_name) : issueLabel(r.issue_type as string | null),
    leadTechnicianName: r.lead_first_name ? String(r.lead_first_name) : null,
    submittedFormNames: ((r.form_names as string[] | null) ?? []).slice(0, 3),
  };
}

function toEstimate(r: Row, rid: string): SiteEstimate {
  const fromFieldPulse = r.from_fp === true;
  const optionCount = Number(r.option_count);
  return {
    id: String(r.id),
    label: fromFieldPulse ? (r.title ? String(r.title) : "Estimate") : estimateLabel(r.created_at as string | Date, optionCount),
    createdAt: iso(r.created_at),
    totalCents: Number(r.total_cents),
    optionCount,
    thisJob: String(r.service_request_id) === rid,
    fromFieldPulse,
  };
}

export type SiteResult = { kind: "not_found" } | { kind: "ok"; view: SiteView };

export async function getSiteView(org: string, me: string, rawRid: string): Promise<SiteResult> {
  const rid = rawRid.toLowerCase();
  if (!(await findReadableJob(org, me, rid))) return { kind: "not_found" };
  const [[selfRow], visit] = await Promise.all([readRows(siteSelfSql(org, rid)), findActiveVisit(org, rid)]);
  if (!selfRow) return { kind: "not_found" };
  const isLead = isActiveLead(visit, me);
  const cust = selfRow.customer_id == null ? null : String(selfRow.customer_id);
  const self: SiteSelf = {
    hasCustomer: cust !== null,
    customerErased: selfRow.customer_erased === true,
    locationId: selfRow.location_id == null ? null : String(selfRow.location_id),
    address: normalizedAddress(selfRow.address_encrypted),
  };
  const title = selfRow.location_label ? String(selfRow.location_label) : "Service address";
  const scope = siteScopeOf(self);

  let matches: string[] = [];
  let unaddressedCount = 0;
  if (cust !== null && !self.customerErased) {
    const [cands, [un]] = await Promise.all([readRows(candidatesSql(org, cust, rid)), readRows(unaddressedSql(org, cust, rid))]);
    const candidates: SiteCandidate[] = cands.map((c) => ({
      id: String(c.id),
      locationId: c.location_id == null ? null : String(c.location_id),
      address: normalizedAddress(c.address_encrypted),
    }));
    matches = siteMatches(self, candidates);
    unaddressedCount = Number(un?.n ?? 0);
  }

  const [past, estimates, membership] = await Promise.all([
    matches.length > 0 ? readRows(pastJobsSql(org, matches)) : Promise.resolve([] as Row[]),
    readRows(openEstimatesSql(org, [rid, ...matches])),
    cust !== null && !self.customerErased ? readMembership(org, cust, rid, self.address) : Promise.resolve<SiteMembership>({ state: "none" }),
  ]);

  return {
    kind: "ok",
    view: {
      scope, title, unaddressedCount, membership, hasCustomer: cust !== null, isLead,
      pastJobs: past.map(toPastJob),
      openEstimates: estimates.map((e) => toEstimate(e, rid)),
    },
  };
}
