/** Site page and Site card copy (M3d spec §7.6, §8). Pure, client-safe; dates in the business timezone. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { formatCentsExact } from "@/lib/admin/money-format";
import { plural } from "@/lib/format/plural";
import { statusLabel } from "@/lib/tech/job-display";
import type { SiteEstimate, SiteMembership, SitePastJob, SiteView } from "@/lib/tech/site-view";

const TZ = BUSINESS_BASE_LOCATION.timezone;
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(iso));

export const SITE_COPY = {
  noPastJobs: "No other jobs at this address.",
  noEstimates: "No open estimates.",
  noAddress: "This job has no saved address, so there's no site history.",
  noCustomer: "No customer on this job yet. Ask the office to add one.",
  notMember: "Not a member.",
  withheld: "Membership is on the customer's account. Ask the office.",
} as const;

/** "Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist" */
export function pastJobLine(j: SitePastJob, timeZone: string = TZ): string {
  const parts = [fmt(j.date, { month: "short", day: "numeric", year: "numeric" }, timeZone), j.kind, statusLabel(j.status)];
  if (j.leadTechnicianName) parts.push(j.leadTechnicianName);
  if (j.submittedFormNames.length > 0) parts.push(`Forms: ${j.submittedFormNames.join(", ")}`);
  return parts.join(" · ");
}

/** Spec §7.6: rows aren't links, except this job's open (native) estimates for the lead — to the M3c estimate page. */
export function estimateHref(jobId: string, e: Pick<SiteEstimate, "id" | "thisJob" | "fromFieldPulse">, isLead: boolean): string | null {
  return isLead && e.thisJob && !e.fromFieldPulse ? `/tech/jobs/${jobId}/estimates/${e.id}` : null;
}

/** "Up to $4,812.00" for several options, the exact total for one. */
export function estimateTotal(e: SiteEstimate): string {
  return e.optionCount > 1 ? `Up to ${formatCentsExact(e.totalCents)}` : formatCentsExact(e.totalCents);
}

export function unaddressedLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 earlier job has no saved address." : `${n} earlier jobs have no saved address.`;
}

export function membershipLines(m: SiteMembership, timeZone: string = TZ): { head: string; visits: string | null; upcoming: Array<{ text: string; thisJob: boolean }> } {
  if (m.state === "none") return { head: SITE_COPY.notMember, visits: null, upcoming: [] };
  if (m.state === "withheld") return { head: SITE_COPY.withheld, visits: null, upcoming: [] };
  const since = fmt(m.startedAt, { month: "short", year: "numeric" }, timeZone);
  const through = m.currentPeriodEnd ? ` · Paid through ${fmt(m.currentPeriodEnd, { month: "short", day: "numeric", year: "numeric" }, timeZone)}` : "";
  return {
    head: `${m.planName} · Member since ${since}${through}`,
    visits: m.visitsPerYear > 0 ? plural(m.visitsPerYear, "visit a year", "visits a year") : null,
    upcoming: m.upcoming.map((u) => ({
      text: `${fmt(u.dueDate, { month: "short", day: "numeric", year: "numeric" }, timeZone)} · ${u.status === "generated" ? "Booked" : "Scheduled"}`,
      thisJob: u.thisJob,
    })),
  };
}

/** The job page's Site card line, and whether it opens the Site page. */
export function siteCardLine(v: SiteView): { text: string; tappable: boolean } {
  if (!v.hasCustomer) return { text: "No customer on this job yet.", tappable: false };
  const thisJobEstimates = v.openEstimates.filter((e) => e.thisJob).length;
  if (v.scope === "none") {
    const est = thisJobEstimates > 0 ? ` · ${plural(thisJobEstimates, "open estimate", "open estimates")}` : "";
    return { text: `No saved address${est}`, tappable: thisJobEstimates > 0 || v.membership.state === "member" };
  }
  const parts: string[] = [];
  if (v.pastJobs.length > 0) parts.push(plural(v.pastJobs.length, "past job", "past jobs"));
  if (v.openEstimates.length > 0) parts.push(plural(v.openEstimates.length, "open estimate", "open estimates"));
  if (v.membership.state === "member") parts.push("Member");
  if (parts.length === 0) return { text: "No history at this address yet.", tappable: false };
  return { text: parts.join(" · "), tappable: true };
}
