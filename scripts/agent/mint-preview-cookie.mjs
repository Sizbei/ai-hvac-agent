#!/usr/bin/env node
/**
 * Mint a DEV "View as" preview cookie (spec P7) for local verification.
 * Prints the raw value on stdout — use it as the `hvac_preview` cookie on
 * http://localhost only, next to the admin session it is bound to.
 *
 *   npx tsx scripts/agent/mint-preview-cookie.mjs <targetUserId>
 *
 * The cookie is bound to an admin session: HVAC_SESSION (a raw
 * hvac_admin_session value) when set, else the admin mint-admin-session.mjs
 * picks (MINT_EMAIL / MINT_ORG_ID). The target must be an active user of that
 * admin's org. Reads .env.local (the DEV Neon branch); refuses the production
 * host. The dev server only honours the cookie for a platform admin, so start
 * it with PLATFORM_ADMIN_EMAILS=<admin email> PLATFORM_ORG_ID=<admin org id>.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const PROD_HOST = "ep-withered-hill";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if ((process.env.DATABASE_URL ?? "").includes(PROD_HOST)) {
  fail("Refusing to mint a preview cookie against the production database.");
}
const targetUserId = process.argv[2];
if (!targetUserId) fail("Usage: mint-preview-cookie.mjs <targetUserId>");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
  fail(`The target user id must be a UUID (got "${targetUserId}").`);
}

const { verifyToken } = await import("../../src/lib/auth/config.ts");
const { signPreviewCookie, PREVIEW_MAX_AGE_S } = await import(
  "../../src/lib/auth/preview-cookie.ts"
);
const { neon } = await import("@neondatabase/serverless");

const sessionToken =
  process.env.HVAC_SESSION ||
  execFileSync("npx", ["tsx", "scripts/agent/mint-admin-session.mjs"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .pop();
const admin = await verifyToken(sessionToken);
if (!admin) fail("The admin session token does not verify.");

const sql = neon(process.env.DATABASE_URL);
const [target] = await sql`
  SELECT id FROM users
  WHERE id = ${targetUserId}::uuid
    AND organization_id = ${admin.organizationId}::uuid
    AND is_active`;
if (!target) fail("The target is not an active user of the admin's org.");
if (target.id === admin.userId) fail("The target must be someone other than the admin.");

const platformEmails = (process.env.PLATFORM_ADMIN_EMAILS ?? "").toLowerCase();
if (!platformEmails.split(",").map((e) => e.trim()).includes(admin.email.toLowerCase())) {
  console.error(
    `Note: start the dev server with PLATFORM_ADMIN_EMAILS=${admin.email} ` +
      `PLATFORM_ORG_ID=${admin.organizationId}, or the preview is ignored.`,
  );
}

console.log(
  await signPreviewCookie(
    {
      adminUserId: admin.userId,
      targetUserId: target.id,
      exp: Math.floor(Date.now() / 1000) + PREVIEW_MAX_AGE_S,
    },
    process.env.AUTH_SECRET ?? "",
  ),
);
