/**
 * One-off backfill: populate customers.email_hash / phone_hash for rows that
 * predate the blind-index columns (migration 0003).
 *
 * After this runs, every customer with an email/phone has a deterministic
 * blind index, so the per-org unique indexes protect existing data too (not
 * just newly-created rows) and dedupe lookups use the fast indexed path instead
 * of the legacy decrypt-and-scan fallback.
 *
 * Idempotent: only touches rows where BOTH hashes are NULL, and skips a value
 * whose hash would collide with an already-hashed row (logging it as a
 * pre-existing duplicate to resolve by hand rather than crashing the backfill).
 *
 * Usage: npx tsx src/lib/db/backfill-customer-hashes.ts
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, isNull, and } from "drizzle-orm";
import * as dotenv from "dotenv";
import { customers } from "./schema";
import { decrypt, blindIndex } from "../crypto";

dotenv.config({ path: ".env.local" });

// Inlined here (rather than imported from crm-queries) so this standalone tsx
// script doesn't pull in the server query module. Must stay byte-for-byte
// identical to crm-queries' normalizeEmail/normalizePhone.
function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

async function backfill(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql);

  const rows = await db
    .select({
      id: customers.id,
      organizationId: customers.organizationId,
      emailEncrypted: customers.emailEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
    })
    .from(customers)
    .where(and(isNull(customers.emailHash), isNull(customers.phoneHash)));

  console.log(`Backfilling ${rows.length} customer row(s)...`);

  // Track hashes already seen per org (within this run) so we don't try to
  // write a duplicate that would violate the unique index.
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = normalizeEmail(safeDecrypt(row.emailEncrypted));
    const phone = normalizePhone(safeDecrypt(row.phoneEncrypted));

    let emailHash = email ? blindIndex(email) : null;
    let phoneHash = phone ? blindIndex(phone) : null;

    const emailKey = emailHash ? `${row.organizationId}:${emailHash}` : null;
    const phoneKey = phoneHash ? `${row.organizationId}:${phoneHash}` : null;

    if (emailKey && seenEmail.has(emailKey)) {
      console.warn(
        `Customer ${row.id}: email duplicates an earlier row — leaving email_hash NULL (resolve manually).`,
      );
      emailHash = null;
    }
    if (phoneKey && seenPhone.has(phoneKey)) {
      console.warn(
        `Customer ${row.id}: phone duplicates an earlier row — leaving phone_hash NULL (resolve manually).`,
      );
      phoneHash = null;
    }

    if (!emailHash && !phoneHash) {
      skipped++;
      continue;
    }

    await db
      .update(customers)
      .set({ emailHash, phoneHash })
      .where(eq(customers.id, row.id));

    if (emailKey && emailHash) seenEmail.add(emailKey);
    if (phoneKey && phoneHash) seenPhone.add(phoneKey);
    updated++;
  }

  console.log(`Backfill complete: ${updated} updated, ${skipped} skipped.`);
}

backfill().catch((error: unknown) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
