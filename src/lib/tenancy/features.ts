import { loadOrgRow } from "./org-row";
import { historyCutoff, parseFeatures, type Features } from "./feature-flags";

/** Per-org feature switches. THROWS on a DB error: callers that gate sends must fail closed. */
export async function getFeatures(organizationId: string): Promise<Features> {
  const row = await loadOrgRow(organizationId);
  return parseFeatures(row?.featureFlags);
}

/** The org's go-live moment (`feature_flags.historyCutoff`), or null. THROWS on a DB error. */
export async function getHistoryCutoff(organizationId: string): Promise<Date | null> {
  const row = await loadOrgRow(organizationId);
  return historyCutoff(row?.featureFlags);
}
