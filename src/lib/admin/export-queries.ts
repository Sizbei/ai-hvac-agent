/**
 * Tenant data export (GDPR portability / due-diligence).
 *
 * exportOrganization returns a decrypted, secret-free JSON snapshot of one
 * org's data. PII columns are decrypted for the export (it IS the data subject's
 * data); SECRETS and irreversible auth material are NEVER included
 * (apiKey/refreshToken/webhookSecret ciphertext, passwordHash, every *TokenHash,
 * and the blind-index hashes). Money stays in integer cents (the caller renders).
 *
 * SCALE CAVEAT: this loads the whole org into memory in a handful of unbounded
 * SELECTs. That's fine for the current single-tenant-at-a-time admin/platform
 * export, but a very large org should stream/paginate (e.g. chunk customers and
 * NDJSON the messages table) rather than materialize one JSON object. Revisit
 * before exposing this to self-serve at scale.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizations,
  customers,
  customerLocations,
  serviceRequests,
  estimates,
  estimateOptions,
  estimateLineItems,
  invoices,
  invoiceLineItems,
  payments,
  refunds,
  financingApplications,
  customerEquipment,
  serviceHistory,
  customerMemberships,
  membershipVisits,
  messages,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";

/** Decrypts a ciphertext column, returning null on absent/corrupt input. */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Builds a decrypted, secret-free export object for a single org.
 * Returns null when the org does not exist.
 */
export async function exportOrganization(
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
      plan: organizations.plan,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  if (!org) return null;

  const scope = <T extends { organizationId: unknown }>(t: T) =>
    eq(t.organizationId as never, organizationId);

  const [
    customerRows,
    locationRows,
    requestRows,
    estimateRows,
    optionRows,
    estimateLineRows,
    invoiceRows,
    invoiceLineRows,
    paymentRows,
    refundRows,
    financingRows,
    equipmentRows,
    historyRows,
    membershipRows,
    visitRows,
    messageRows,
  ] = await Promise.all([
    db.select().from(customers).where(scope(customers)),
    db.select().from(customerLocations).where(scope(customerLocations)),
    db.select().from(serviceRequests).where(scope(serviceRequests)),
    db.select().from(estimates).where(scope(estimates)),
    db.select().from(estimateOptions).where(scope(estimateOptions)),
    db.select().from(estimateLineItems).where(scope(estimateLineItems)),
    db.select().from(invoices).where(scope(invoices)),
    db.select().from(invoiceLineItems).where(scope(invoiceLineItems)),
    db.select().from(payments).where(scope(payments)),
    db.select().from(refunds).where(scope(refunds)),
    db
      .select()
      .from(financingApplications)
      .where(scope(financingApplications)),
    db.select().from(customerEquipment).where(scope(customerEquipment)),
    db.select().from(serviceHistory).where(scope(serviceHistory)),
    db.select().from(customerMemberships).where(scope(customerMemberships)),
    db.select().from(membershipVisits).where(scope(membershipVisits)),
    db.select().from(messages).where(scope(messages)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    organization: org,
    // Customers: decrypt PII, include the erasure marker, NEVER emit the blind
    // index hashes or the portal token hash.
    customers: customerRows.map((c) => ({
      id: c.id,
      name: safeDecrypt(c.nameEncrypted),
      phone: safeDecrypt(c.phoneEncrypted),
      email: safeDecrypt(c.emailEncrypted),
      address: safeDecrypt(c.addressEncrypted),
      propertyType: c.propertyType,
      propertySqft: c.propertySqft,
      notes: c.notes,
      customerType: c.customerType,
      membershipStatus: c.membershipStatus,
      doNotService: c.doNotService,
      anonymizedAt: c.anonymizedAt,
      archivedAt: c.archivedAt,
      createdAt: c.createdAt,
    })),
    customerLocations: locationRows.map((l) => ({
      id: l.id,
      customerId: l.customerId,
      address: safeDecrypt(l.addressEncrypted),
      label: l.label,
      zone: l.zone,
      propertyType: l.propertyType,
      accessNotes: l.accessNotes,
      latitude: l.latitude,
      longitude: l.longitude,
      createdAt: l.createdAt,
    })),
    serviceRequests: requestRows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      referenceNumber: r.referenceNumber,
      status: r.status,
      issueType: r.issueType,
      urgency: r.urgency,
      description: r.description,
      customerName: safeDecrypt(r.customerNameEncrypted),
      customerPhone: safeDecrypt(r.customerPhoneEncrypted),
      customerEmail: safeDecrypt(r.customerEmailEncrypted),
      address: safeDecrypt(r.addressEncrypted),
      signatureName: r.signatureName,
      scheduledDate: r.scheduledDate,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    })),
    estimates: estimateRows.map((e) => ({
      id: e.id,
      customerId: e.customerId,
      serviceRequestId: e.serviceRequestId,
      status: e.status,
      totalCents: e.totalCents,
      signatureName: e.signatureName,
      signedAt: e.signedAt,
      createdAt: e.createdAt,
    })),
    estimateOptions: optionRows,
    estimateLineItems: estimateLineRows,
    invoices: invoiceRows,
    invoiceLineItems: invoiceLineRows,
    payments: paymentRows,
    refunds: refundRows,
    financingApplications: financingRows,
    customerEquipment: equipmentRows,
    serviceHistory: historyRows,
    customerMemberships: membershipRows,
    membershipVisits: visitRows,
    messages: messageRows.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
}

/**
 * Per-table row counts for the export — used by the audit trail so we record
 * WHAT was exported (counts only) without ever logging the payload itself.
 */
export function exportCounts(
  exported: Record<string, unknown>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(exported)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}
