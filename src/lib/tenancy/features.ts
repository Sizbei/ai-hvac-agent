import { loadOrgRow } from "./org-row";
import { parseFeatures, type Features } from "./feature-flags";

/** Per-org feature switches. THROWS on a DB error: callers that gate sends must fail closed. */
export async function getFeatures(organizationId: string): Promise<Features> {
  const row = await loadOrgRow(organizationId);
  return parseFeatures(row?.featureFlags);
}
