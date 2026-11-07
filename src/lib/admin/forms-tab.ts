/** Pure display rules for the Settings → Forms tab (M3d spec §7.1). Client-safe. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

/** "All requests", else the job type names (archived ones included: the list comes from the full job types GET). */
export function formsTabAppliesTo(ids: readonly string[], jobTypes: ReadonlyArray<{ readonly id: string; readonly name: string }>): string {
  if (ids.length === 0) return "All requests";
  const byId = new Map(jobTypes.map((j) => [j.id, j.name]));
  const names = ids.map((id) => byId.get(id)).filter((n): n is string => n !== undefined);
  return names.length > 0 ? names.join(", ") : "Some job types";
}

/** "Nov 7, 2026" in the business timezone. */
export function formatChangedAt(iso: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}
