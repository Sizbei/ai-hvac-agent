/**
 * Demo-only behaviour is keyed off the DEMO_MODE_ORG_IDS env var (comma
 * separated org ids). Empty/unset on prod, so no live org is a demo org.
 */
export function isDemoOrg(
  organizationId: string,
  list: string | undefined = process.env.DEMO_MODE_ORG_IDS,
): boolean {
  if (!list) return false;
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(organizationId);
}
