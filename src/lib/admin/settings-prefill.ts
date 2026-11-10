/**
 * Fill-the-gaps prefill for an org's settings (go-live Task 30). Pure: it
 * returns only the keys that are empty today, so an existing value always
 * wins. The facts are the PUBLIC, verified Spears facts. Business hours (the
 * only source is directory listings) and the logo (no asset) are deliberately
 * absent, and `prefillPatch` ignores them even if a caller passes them.
 */

export const PROD_HOST = "ep-withered-hill";

export interface PrefillFacts {
  readonly companyName: string;
  readonly timezone: string;
  readonly phone: string;
  readonly serviceArea: string;
  readonly website: string;
}

export const SPEARS_FACTS: PrefillFacts = Object.freeze({
  companyName: "Spears Services, Inc.",
  timezone: "America/New_York",
  phone: "423-854-9505",
  serviceArea: "NE Tennessee, SW Virginia, Western North Carolina",
  website: "https://spearsservices.com",
});

export interface PrefillCurrent {
  readonly companyName: string | null;
  readonly logoUrl: string | null;
  readonly businessInfo: Readonly<Record<string, unknown>>;
  /** after_hours_config.timezone; null when unset. */
  readonly timezone: string | null;
}

export interface PrefillPatch {
  businessInfo?: Record<string, string>;
  companyName?: string;
  timezone?: string;
}

/** The business_info keys the prefill may fill, in display order. */
const BUSINESS_INFO_KEYS = ["phone", "serviceArea", "website"] as const;

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function prefillPatch(current: PrefillCurrent, facts: PrefillFacts): PrefillPatch {
  const patch: PrefillPatch = {};
  if (isEmpty(current.companyName)) patch.companyName = facts.companyName;
  if (isEmpty(current.timezone)) patch.timezone = facts.timezone;
  const info: Record<string, string> = {};
  for (const key of BUSINESS_INFO_KEYS) {
    if (isEmpty(current.businessInfo[key])) info[key] = facts[key];
  }
  if (Object.keys(info).length > 0) patch.businessInfo = info;
  return patch;
}

export interface EmptyKeyReport {
  /** Empty keys, by name only. */
  readonly empty: readonly string[];
  /** What to confirm with Chick before the checklist can go green. */
  readonly confirmWithChick: readonly string[];
}

export function emptyKeyReport(current: PrefillCurrent): EmptyKeyReport {
  const empty: string[] = [];
  if (isEmpty(current.companyName)) empty.push("company_name");
  if (isEmpty(current.logoUrl)) empty.push("logo_url");
  if (isEmpty(current.timezone)) empty.push("after_hours_config.timezone");
  for (const key of ["businessHours", ...BUSINESS_INFO_KEYS]) {
    if (isEmpty(current.businessInfo[key])) empty.push(`business_info.${key}`);
  }
  const confirmWithChick = ["business hours", "logo"];
  if (isEmpty(current.businessInfo.phone)) confirmWithChick.push("business phone");
  return { empty, confirmWithChick: orderConfirm(confirmWithChick) };
}

function orderConfirm(items: string[]): string[] {
  const order = ["business hours", "logo", "business phone"];
  return order.filter((x) => items.includes(x));
}

export const isProdDatabaseUrl = (url: string): boolean =>
  url.toLowerCase().includes(PROD_HOST);
