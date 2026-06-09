/**
 * PURE Housecall Pro technician → scheduling tech-id mapping.
 *
 * The scheduling-source seam reports a roster of opaque "technician ids" — the
 * bookable-staff count the open-window aggregation uses. Until now that roster
 * was SYNTHETIC (one placeholder per HCP availability window). This module maps
 * the REAL HCP technician (employee) roster to the SAME opaque-id shape, so the
 * count reflects actual staff instead of window count.
 *
 * Like availability-mapping.ts, the emitted ids are OPAQUE: they carry NO HCP
 * staff name — only HCP's employee id, prefixed — so the PII-free guarantee of
 * the public availability surface holds (the worst leak is still an opaque id /
 * a count, never a name). We deliberately do NOT forward the technician's name.
 *
 * Active filter: HCP can return deactivated employees; only staff who can still
 * take jobs should count toward capacity. We keep a tech when `isActive` is true
 * OR undefined (HCP omitted the flag) — an absent flag must not silently drop a
 * real technician — and drop only explicitly inactive (`isActive === false`)
 * rows. Rows without an id can't be mapped and are dropped.
 *
 * This module is PURE (no I/O, no Date.now): given an already-fetched roster it
 * returns the opaque ids, so it unit-tests deterministically.
 */
import type { HousecallTechnician } from "./types";

/** A stable prefix for opaque HCP technician ids. Carries only HCP's employee
 * id (never a name), so the no-PII guarantee of the availability surface holds. */
export const HCP_TECH_ID_PREFIX = "hcp-tech-";

/** Map one HCP employee id to its opaque scheduling tech id. */
export function toHcpTechId(employeeId: string): string {
  return `${HCP_TECH_ID_PREFIX}${employeeId}`;
}

/**
 * Whether a technician should count toward the active roster. Active when HCP
 * reports `isActive: true` OR omits the flag (undefined) — only an explicit
 * `false` excludes them, so an absent flag never silently drops real staff.
 */
function isActiveTechnician(tech: HousecallTechnician): boolean {
  return tech.isActive !== false;
}

/**
 * Map an HCP technician roster to the opaque tech ids the scheduling source
 * reports. Filters to active staff (see {@link isActiveTechnician}), drops rows
 * without an id, and de-duplicates so a repeated HCP id counts once. Tolerant of
 * missing names — names are intentionally never forwarded.
 */
export function mapHcpTechnicians(
  technicians: readonly HousecallTechnician[],
): readonly string[] {
  const ids = new Set<string>();
  for (const tech of technicians) {
    if (typeof tech.id !== "string" || tech.id.length === 0) {
      continue;
    }
    if (!isActiveTechnician(tech)) {
      continue;
    }
    ids.add(toHcpTechId(tech.id));
  }
  return Array.from(ids);
}
