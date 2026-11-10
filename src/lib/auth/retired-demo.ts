/**
 * The public demo logins (`@demo-hvac.com`) are retired: production's org is a
 * real client's live account, and those credentials were published. This is the
 * ONE shared refusal every sign-in path (admin + technician password, Google,
 * invite accept) and the live-session revocation check consult.
 *
 * Pure (no `server-only`) so it can be unit-tested and reused anywhere.
 */
const RETIRED_DEMO_DOMAIN_SUFFIX = "@demo-hvac.com";

export function isRetiredDemoEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(RETIRED_DEMO_DOMAIN_SUFFIX);
}
