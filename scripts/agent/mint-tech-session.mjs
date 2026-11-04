#!/usr/bin/env node
/**
 * Mint a dev technician session JWT for local verification (Playwright/curl).
 * Prints the raw token on stdout — use as the `hvac_tech_session` cookie.
 *
 * The payload MUST include `name`, `email`, `userId`, `organizationId`, and
 * `role: "technician"` — verifyTechToken rejects tokens missing any of these,
 * and separately requires the `aud: "hvac-tech"` claim that signTechToken sets
 * (that's what keeps this out of the admin session's cookie slot).
 * Reads .env.local (the DEV Neon branch — never point it at prod).
 *
 *   node scripts/agent/mint-tech-session.mjs
 */
import { readFileSync } from "fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { signTechToken } = await import("../../src/lib/auth/tech-config.ts");
const { neon } = await import("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
// Optional: scope the pick to one tenant (a throwaway org). Unset = unchanged.
const orgId = process.env.MINT_ORG_ID || null;
const [u] = await sql`
  SELECT id, email, name, role, organization_id
  FROM users
  WHERE role = 'technician' AND is_active
    AND (${orgId}::uuid IS NULL OR organization_id = ${orgId}::uuid)
  LIMIT 1`;
if (!u) {
  console.error(
    orgId
      ? `no active technician in org ${orgId}`
      : "no active technician in the dev DB",
  );
  process.exit(1);
}
console.log(
  await signTechToken({
    userId: u.id,
    email: u.email,
    name: u.name ?? "Technician",
    role: "technician",
    organizationId: u.organization_id,
  }),
);
