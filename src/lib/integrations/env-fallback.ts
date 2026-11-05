/** Same value as DEMO_ORG_ID in @/lib/tenancy/organization (server-only, so not imported here; a test pins them equal). */
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Single-tenant env-key fallback guard for the FieldPulse and Housecall Pro
 * integrations. The env keys (FIELDPULSE_API_KEY, HOUSECALL_API_KEY) belong to
 * ONE business's account, so only that business's org may use them: the
 * platform org (PLATFORM_ORG_ID, which is the demo/default org id when unset).
 * Every other org must connect its own account. Without this guard any new
 * tenant without a connection row would read and push jobs into the
 * single-tenant account.
 */
export function envKeyFallbackAllowed(organizationId: string): boolean {
  const platformOrgId = process.env.PLATFORM_ORG_ID?.trim() || DEFAULT_ORG_ID;
  return organizationId === platformOrgId;
}
