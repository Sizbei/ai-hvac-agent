#!/usr/bin/env node
/**
 * Mint a dev admin session JWT for local verification (Playwright/curl).
 * Prints the raw token on stdout — use as the `hvac_admin_session` cookie.
 *
 * The payload MUST include `name`: verifyToken rejects tokens without it.
 * Reads .env.local (the DEV Neon branch — never point it at prod). Refuses the
 * production host (ep-withered-hill) unless --prod is passed.
 *
 *   node scripts/agent/mint-admin-session.mjs
 */
import { readFileSync } from "fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { signToken } = await import("../../src/lib/auth/config.ts");
const { neon } = await import("@neondatabase/serverless");
const { mintProdRefusal } = await import("../../src/lib/deploy/mint-guard.ts");

const refusal = mintProdRefusal(process.env.DATABASE_URL, process.argv.slice(2));
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
// Optional: scope the pick to one tenant (e.g. the fictional demo org) instead
// of "whichever super_admin comes first". Unset = unchanged behavior.
const orgId = process.env.MINT_ORG_ID || null;
// Optional: pick this exact active admin-tier user. Demo users are always
// skipped (sessions for retired demo emails are refused).
const email = process.env.MINT_EMAIL || null;
const [u] = await sql`
  SELECT id, email, name, role, organization_id
  FROM users
  WHERE is_active
    AND (
      (${email}::text IS NOT NULL AND lower(email) = lower(${email}::text)
        AND role IN ('super_admin', 'admin'))
      OR (${email}::text IS NULL AND role = 'super_admin')
    )
    AND lower(email) NOT LIKE '%@demo-hvac.com'
    AND (${orgId}::uuid IS NULL OR organization_id = ${orgId}::uuid)
  ORDER BY created_at, id
  LIMIT 1`;
if (!u) {
  console.error("no active super_admin in the dev DB");
  process.exit(1);
}
console.log(
  await signToken({
    userId: u.id,
    email: u.email,
    name: u.name ?? "Admin",
    role: u.role,
    organizationId: u.organization_id,
  }),
);
