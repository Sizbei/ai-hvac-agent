import { loadOrgRow, loadOrgRowCached } from "./org-row";
import { historyCutoff, parseFeatures, type Features } from "./feature-flags";

/**
 * Per-org feature switches, read live. THROWS on a DB error: callers that gate
 * sends (consent, money triggers) must fail closed, so they use this one.
 */
export async function getFeatures(organizationId: string): Promise<Features> {
  const row = await loadOrgRow(organizationId);
  return parseFeatures(row?.featureFlags);
}

/** The org's go-live moment (`feature_flags.historyCutoff`), or null. THROWS on a DB error. */
export async function getHistoryCutoff(organizationId: string): Promise<Date | null> {
  const row = await loadOrgRow(organizationId);
  return historyCutoff(row?.featureFlags);
}

/**
 * Display reads (viewer, Map switch, audit cutoff): the same parse over the
 * 30 s TTL-cached org row (org-row.ts). A switch turned off on another
 * instance can read "on" for up to 30 s. Never use these to gate a send or a
 * charge. THROW on a DB error.
 */
export async function getCachedFeatures(organizationId: string): Promise<Features> {
  const row = await loadOrgRowCached(organizationId);
  return parseFeatures(row?.featureFlags);
}

export async function getCachedHistoryCutoff(organizationId: string): Promise<Date | null> {
  const row = await loadOrgRowCached(organizationId);
  return historyCutoff(row?.featureFlags);
}
