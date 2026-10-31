import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerContacts } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { computeContactHashes } from "@/lib/admin/crm-queries";
import { locationBelongsToCustomer } from "@/lib/admin/location-queries";
import type { ContactInput, ContactPatch, ContactRecord } from "./contact-types";

function safeDecrypt(v: string | null): string | null { if (!v) return null; try { return decrypt(v); } catch { return null; } }
function toRecord(r: typeof customerContacts.$inferSelect): ContactRecord {
  return { id: r.id, customerId: r.customerId, locationId: r.locationId, name: safeDecrypt(r.nameEncrypted) ?? "", role: r.role,
    phone: safeDecrypt(r.phoneEncrypted), email: safeDecrypt(r.emailEncrypted), isPrimary: r.isPrimary, position: r.position };
}

/** Encrypt + blind-index exactly like customers (same normaliser). */
export function toContactRow(name: string, phone: string | null, email: string | null) {
  const hashes = computeContactHashes({ email, phone });
  return { nameEncrypted: encrypt(name), phoneEncrypted: phone ? encrypt(phone) : null, phoneHash: hashes.phoneHash,
    emailEncrypted: email ? encrypt(email) : null, emailHash: hashes.emailHash };
}

export async function listContacts(organizationId: string, customerId: string): Promise<readonly ContactRecord[]> {
  const rows = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId)))
    .orderBy(asc(customerContacts.position), asc(customerContacts.createdAt));
  return rows.map(toRecord);
}

export async function contactBelongsToCustomer(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const [row] = await db.select({ id: customerContacts.id }).from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))).limit(1);
  return Boolean(row);
}

/** One primary per customer (customer_contacts_one_primary_idx). Setting a
 * new primary unsets the others in the same batch. */
function unsetPrimary(organizationId: string, customerId: string) {
  return db.update(customerContacts).set({ isPrimary: false })
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
}

export async function createContact(organizationId: string, customerId: string, input: ContactInput): Promise<ContactRecord | { readonly reason: "location_not_owned" }> {
  if (input.locationId && !(await locationBelongsToCustomer(organizationId, customerId, input.locationId))) return { reason: "location_not_owned" };
  const id = randomUUID();
  const insert = db.insert(customerContacts).values({
    id, organizationId, customerId, locationId: input.locationId, role: input.role, isPrimary: input.isPrimary ?? false,
    ...toContactRow(input.name, input.phone, input.email),
  });
  if (input.isPrimary) await db.batch([unsetPrimary(organizationId, customerId), insert]); else await insert;
  const [row] = await db.select().from(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, id))).limit(1);
  if (!row) throw new Error("Failed to create contact");
  return toRecord(row);
}

export async function updateContact(organizationId: string, customerId: string, contactId: string, patch: ContactPatch): Promise<ContactRecord | null | { readonly reason: "location_not_owned" }> {
  if (patch.locationId && !(await locationBelongsToCustomer(organizationId, customerId, patch.locationId))) return { reason: "location_not_owned" };
  const [existing] = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))).limit(1);
  if (!existing) return null;
  const name = patch.name ?? safeDecrypt(existing.nameEncrypted) ?? "";
  const phone = patch.phone === undefined ? safeDecrypt(existing.phoneEncrypted) : patch.phone;
  const email = patch.email === undefined ? safeDecrypt(existing.emailEncrypted) : patch.email;
  const update = db.update(customerContacts).set({
    ...toContactRow(name, phone, email),
    role: patch.role === undefined ? existing.role : patch.role,
    locationId: patch.locationId === undefined ? existing.locationId : patch.locationId,
    isPrimary: patch.isPrimary ?? existing.isPrimary,
    updatedAt: new Date(),
  }).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId)));
  if (patch.isPrimary === true && !existing.isPrimary) await db.batch([unsetPrimary(organizationId, customerId), update]); else await update;
  const [row] = await db.select().from(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId))).limit(1);
  return row ? toRecord(row) : null;
}

export async function deleteContact(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const rows = await db.delete(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
    .returning({ id: customerContacts.id });
  return rows.length > 0;
}
