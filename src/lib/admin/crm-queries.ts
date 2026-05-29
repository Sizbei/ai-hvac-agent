import { eq, desc, asc, count, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  customerEquipment,
  customerNotes,
  followUps,
  serviceHistory,
  serviceRequests,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import type {
  CustomerRecord,
  CustomerDetail,
  CreateCustomerInput,
  CreateEquipmentInput,
  CreateNoteInput,
  CreateFollowUpInput,
} from "./crm-types";

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

export async function getCustomers(
  organizationId: string,
): Promise<readonly CustomerRecord[]> {
  const rows = await db
    .select({
      id: customers.id,
      nameEncrypted: customers.nameEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      emailEncrypted: customers.emailEncrypted,
      addressEncrypted: customers.addressEncrypted,
      propertyType: customers.propertyType,
      propertySqft: customers.propertySqft,
      notes: customers.notes,
      createdAt: customers.createdAt,
      equipmentCount: sql<number>`(
        SELECT count(*)::int FROM customer_equipment
        WHERE customer_equipment.customer_id = ${customers.id}
      )`,
      requestCount: sql<number>`(
        SELECT count(*)::int FROM service_requests
        WHERE service_requests.customer_id = ${customers.id}
      )`,
      lastServiceDate: sql<string | null>`(
        SELECT max(service_requests.created_at)::text FROM service_requests
        WHERE service_requests.customer_id = ${customers.id}
      )`,
    })
    .from(customers)
    .where(withTenant(customers, organizationId))
    .orderBy(desc(customers.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: safeDecrypt(row.nameEncrypted),
    phone: safeDecrypt(row.phoneEncrypted),
    email: safeDecrypt(row.emailEncrypted),
    address: safeDecrypt(row.addressEncrypted),
    propertyType: row.propertyType,
    propertySqft: row.propertySqft,
    notes: row.notes,
    equipmentCount: row.equipmentCount ?? 0,
    requestCount: row.requestCount ?? 0,
    lastServiceDate: row.lastServiceDate,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getCustomerById(
  organizationId: string,
  customerId: string,
): Promise<CustomerDetail | null> {
  const [row] = await db
    .select()
    .from(customers)
    .where(
      withTenant(customers, organizationId, eq(customers.id, customerId)),
    );

  if (!row) return null;

  const [equipmentRows, noteRows, followUpRows, historyRows] =
    await Promise.all([
      db
        .select()
        .from(customerEquipment)
        .where(
          withTenant(
            customerEquipment,
            organizationId,
            eq(customerEquipment.customerId, customerId),
          ),
        )
        .orderBy(desc(customerEquipment.createdAt)),

      db
        .select({
          id: customerNotes.id,
          content: customerNotes.content,
          noteType: customerNotes.noteType,
          createdAt: customerNotes.createdAt,
          authorName: users.name,
        })
        .from(customerNotes)
        .leftJoin(users, eq(customerNotes.authorId, users.id))
        .where(
          withTenant(
            customerNotes,
            organizationId,
            eq(customerNotes.customerId, customerId),
          ),
        )
        .orderBy(desc(customerNotes.createdAt)),

      db
        .select({
          id: followUps.id,
          reason: followUps.reason,
          dueDate: followUps.dueDate,
          status: followUps.status,
          completedAt: followUps.completedAt,
          createdAt: followUps.createdAt,
          assignedToName: users.name,
        })
        .from(followUps)
        .leftJoin(users, eq(followUps.assignedTo, users.id))
        .where(
          withTenant(
            followUps,
            organizationId,
            eq(followUps.customerId, customerId),
          ),
        )
        .orderBy(desc(followUps.dueDate)),

      db
        .select({
          id: serviceHistory.id,
          serviceRequestId: serviceHistory.serviceRequestId,
          workPerformed: serviceHistory.workPerformed,
          partsUsed: serviceHistory.partsUsed,
          cost: serviceHistory.cost,
          technicianNotes: serviceHistory.technicianNotes,
          followUpNeeded: serviceHistory.followUpNeeded,
          createdAt: serviceHistory.createdAt,
          referenceNumber: serviceRequests.referenceNumber,
          issueType: serviceRequests.issueType,
          status: serviceRequests.status,
        })
        .from(serviceHistory)
        .leftJoin(
          serviceRequests,
          eq(serviceHistory.serviceRequestId, serviceRequests.id),
        )
        .where(
          withTenant(
            serviceHistory,
            organizationId,
            eq(serviceHistory.customerId, customerId),
          ),
        )
        .orderBy(desc(serviceHistory.createdAt)),
    ]);

  const requestCount = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.customerId, customerId),
      ),
    );

  return {
    id: row.id,
    name: safeDecrypt(row.nameEncrypted),
    phone: safeDecrypt(row.phoneEncrypted),
    email: safeDecrypt(row.emailEncrypted),
    address: safeDecrypt(row.addressEncrypted),
    propertyType: row.propertyType,
    propertySqft: row.propertySqft,
    notes: row.notes,
    equipmentCount: equipmentRows.length,
    requestCount: requestCount[0]?.value ?? 0,
    lastServiceDate: null,
    createdAt: row.createdAt.toISOString(),
    equipment: equipmentRows.map((e) => ({
      id: e.id,
      equipmentType: e.equipmentType,
      make: e.make,
      model: e.model,
      serialNumber: e.serialNumber,
      installDate: e.installDate?.toISOString() ?? null,
      warrantyExpiration: e.warrantyExpiration?.toISOString() ?? null,
      locationInHome: e.locationInHome,
      notes: e.notes,
    })),
    serviceHistory: historyRows.map((h) => ({
      id: h.id,
      serviceRequestId: h.serviceRequestId,
      referenceNumber: h.referenceNumber ?? null,
      issueType: h.issueType ?? null,
      status: h.status ?? null,
      workPerformed: h.workPerformed,
      partsUsed: h.partsUsed,
      cost: h.cost,
      technicianNotes: h.technicianNotes,
      followUpNeeded: h.followUpNeeded,
      createdAt: h.createdAt.toISOString(),
    })),
    customerNotes: noteRows.map((n) => ({
      id: n.id,
      authorName: n.authorName,
      content: n.content,
      noteType: n.noteType,
      createdAt: n.createdAt.toISOString(),
    })),
    followUps: followUpRows.map((f) => ({
      id: f.id,
      assignedToName: f.assignedToName,
      reason: f.reason,
      dueDate: f.dueDate.toISOString(),
      status: f.status,
      completedAt: f.completedAt?.toISOString() ?? null,
      createdAt: f.createdAt.toISOString(),
    })),
  };
}

export async function createCustomer(
  organizationId: string,
  input: CreateCustomerInput,
): Promise<CustomerRecord> {
  const [created] = await db
    .insert(customers)
    .values({
      organizationId,
      nameEncrypted: encrypt(input.name),
      phoneEncrypted: input.phone ? encrypt(input.phone) : null,
      emailEncrypted: input.email ? encrypt(input.email) : null,
      addressEncrypted: input.address ? encrypt(input.address) : null,
      propertyType: input.propertyType ?? null,
      propertySqft: input.propertySqft ?? null,
      notes: input.notes ?? null,
    })
    .returning();

  if (!created) throw new Error("Failed to create customer");

  return {
    id: created.id,
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    propertyType: created.propertyType,
    propertySqft: created.propertySqft,
    notes: created.notes,
    equipmentCount: 0,
    requestCount: 0,
    lastServiceDate: null,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function addEquipment(
  organizationId: string,
  customerId: string,
  input: CreateEquipmentInput,
): Promise<void> {
  await db.insert(customerEquipment).values({
    customerId,
    organizationId,
    equipmentType: input.equipmentType as "ac" | "furnace" | "heat_pump" | "boiler" | "mini_split" | "thermostat" | "other",
    make: input.make ?? null,
    model: input.model ?? null,
    serialNumber: input.serialNumber ?? null,
    installDate: input.installDate ? new Date(input.installDate) : null,
    warrantyExpiration: input.warrantyExpiration
      ? new Date(input.warrantyExpiration)
      : null,
    locationInHome: input.locationInHome ?? null,
    notes: input.notes ?? null,
  });
}

export async function addNote(
  organizationId: string,
  customerId: string,
  authorId: string,
  input: CreateNoteInput,
): Promise<void> {
  await db.insert(customerNotes).values({
    customerId,
    organizationId,
    authorId,
    content: input.content,
    noteType: (input.noteType ?? "general") as "general" | "follow_up" | "complaint" | "compliment",
  });
}

export async function addFollowUp(
  organizationId: string,
  customerId: string,
  input: CreateFollowUpInput,
): Promise<void> {
  await db.insert(followUps).values({
    customerId,
    organizationId,
    assignedTo: input.assignedTo ?? null,
    reason: input.reason,
    dueDate: new Date(input.dueDate),
    status: "pending",
  });
}
