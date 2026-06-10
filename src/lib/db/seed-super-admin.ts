/**
 * Idempotent seed: provision rchen.workmail@gmail.com as a super_admin.
 *
 * This account is GOOGLE-ONLY (passwordHash = NULL) — it can sign in only via
 * "Sign in with Google" (OIDC), never with a password. It is the seeded owner of
 * the demo organization.
 *
 * Idempotent: if the row already exists it is PROMOTED to super_admin and
 * reactivated (without touching an existing google_id link); otherwise it is
 * created. Safe to run repeatedly.
 *
 *   npm run db:seed:super-admin
 *
 * Requires DATABASE_URL. There is no transaction (neon-http) — the operations
 * are a single-row read then a single write, so this is naturally atomic enough
 * for a one-row seed.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SUPER_ADMIN_EMAIL = "rchen.workmail@gmail.com";
const SUPER_ADMIN_NAME = "Raymond Chen";

export async function seedSuperAdmin(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql, { schema });

  const email = SUPER_ADMIN_EMAIL.trim().toLowerCase();

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.organizationId, DEMO_ORG_ID),
        eq(schema.users.email, email),
      ),
    )
    .limit(1);

  if (existing) {
    // Promote + reactivate; leave name/google_id/password_hash as-is so a prior
    // Google link or chosen name survives re-runs.
    await db
      .update(schema.users)
      .set({ role: "super_admin", isActive: true })
      .where(eq(schema.users.id, existing.id));
    console.log(`  Promoted existing user to super_admin: ${email}`);
    return;
  }

  await db.insert(schema.users).values({
    organizationId: DEMO_ORG_ID,
    email,
    name: SUPER_ADMIN_NAME,
    // passwordHash omitted → NULL → Google-only login.
    role: "super_admin",
    isActive: true,
  });
  console.log(`  Created super_admin (Google-only): ${email}`);
}

// Run when invoked directly (tsx src/lib/db/seed-super-admin.ts).
if (process.argv[1] && process.argv[1].includes("seed-super-admin")) {
  seedSuperAdmin()
    .then(() => {
      console.log("✓ super_admin seed complete");
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("super_admin seed failed:", error);
      process.exit(1);
    });
}
