/**
 * PURE intake -> Housecall Pro LINE ITEMS mapping.
 *
 * Today a request reaches HCP as a free-text description only. HCP jobs also
 * support structured LINE ITEMS (service/material/labor rows with a name, qty
 * and an OPTIONAL unit price). This module derives those rows from the intake so
 * a tech sees a checklist alongside the description — IN ADDITION TO it, never
 * instead of it.
 *
 * NO PRICING (CRITICAL): this business charges for actual work done on-site —
 * there is no flat fee and no intake-time pricing. Every item we emit is
 * DESCRIPTIVE: `unitPriceCents` is NEVER set here, and `quantity` is a plain
 * count (1), never a dollar amount. The tech prices the job on-site. Do not add
 * any price/fee logic to this file.
 *
 * No DB, no network, no `fetch` — deterministic and unit-testable in isolation.
 */
import type { HousecallLineItem } from "./types";

/**
 * The slice of intake the line-item builder reads. A subset of the request,
 * decoupled from the DB row so this stays pure and fixtures are trivial. All
 * fields optional/nullable: the intake fills them only when known.
 */
export interface LineItemSource {
  /** Customer-language symptom, e.g. "No cooling". Always present on a request. */
  readonly issueType: string;
  /** Work classification enum value, e.g. "no_cool" / "maintenance". */
  readonly jobType?: string | null;
  /** The HVAC system the issue concerns, e.g. "central_ac". */
  readonly systemType?: string | null;
  /** Free-text access notes — gate code, pets, parking, unit location. */
  readonly accessNotes?: string | null;
}

/** Title-case a snake_case enum value: "central_ac" -> "Central Ac". */
function humanizeEnum(value: string): string {
  return value
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Trim to a non-empty string, or null when blank/absent. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Derive descriptive HCP line items from the intake. Deterministic; emits rows
 * only for the fields that are present, and never sets a price:
 *
 *  - One "service" line for the diagnostic/visit, labelled from the work type
 *    when known (e.g. "Diagnostic — No Cool") and qualified by the symptom.
 *  - One "service" line naming the affected system when systemType is known
 *    (e.g. "Central Ac service") so parts prep is visible at a glance.
 *  - One "labor" line carrying the access notes when present, so the tech sees
 *    gate codes / pet / parking caveats as a discrete row.
 *
 * Returns an empty array only in the degenerate case where issueType is blank
 * AND nothing else is known (callers then simply omit lineItems).
 */
export function buildLineItemsFromRequest(
  source: LineItemSource,
): readonly HousecallLineItem[] {
  const items: HousecallLineItem[] = [];

  const symptom = clean(source.issueType);
  const jobType = clean(source.jobType);
  const systemType = clean(source.systemType);
  const accessNotes = clean(source.accessNotes);

  // 1) The diagnostic/visit service line. Prefer the work classification for
  //    the label and qualify it with the customer's symptom when both exist.
  const workLabel = jobType ? humanizeEnum(jobType) : "Service Call";
  if (jobType || symptom) {
    const name =
      jobType && symptom
        ? `${workLabel} — ${symptom}`
        : symptom
          ? `Service Call — ${symptom}`
          : workLabel;
    // NO unitPriceCents — descriptive only; the tech prices on-site.
    items.push({ name, kind: "service", quantity: 1 });
  }

  // 2) The affected-system line (parts prep visibility).
  if (systemType) {
    items.push({
      name: `${humanizeEnum(systemType)} service`,
      kind: "service",
      quantity: 1,
    });
  }

  // 3) Access notes as a discrete row the tech won't miss.
  if (accessNotes) {
    items.push({
      name: "Site access",
      kind: "labor",
      quantity: 1,
      description: accessNotes,
    });
  }

  return items;
}
