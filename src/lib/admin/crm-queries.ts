import {
  and,
  eq,
  ne,
  or,
  asc,
  desc,
  count,
  sql,
  isNull,
  isNotNull,
  inArray,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  customerEquipment,
  customerLocations,
  entityTags,
  customerNotes,
  followUps,
  serviceHistory,
  serviceRequests,
  users,
  auditLog,
  customerTypeEnum,
  membershipStatusEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logAudit } from "@/lib/admin/audit";
import {
  pickCustomerMatch,
  customerMatchCandidatePredicate,
  CUSTOMER_MATCH_CANDIDATE_LIMIT,
  type CustomerMatch,
  type CustomerMatchCandidate,
} from "@/lib/admin/customer-match";
import { encrypt, decrypt, blindIndex } from "@/lib/crypto";
import { customerMatchesSearch, CustomerScanCache } from "@/lib/admin/customer-search";
import {
  sanitizeName,
  sanitizePhone,
  sanitizeAddress,
  sanitizeEmail,
} from "@/lib/ai/sanitize-fields";
import type {
  CustomerRecord,
  CustomerListRecord,
  CustomerListPage,
  CustomerDetail,
  CreateCustomerInput,
  CreateEquipmentInput,
  CreateNoteInput,
  CreateFollowUpInput,
  UpdateCustomerInput,
  UpdateCustomerResult,
} from "./crm-types";

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Default customers-list page size. */
export const CUSTOMERS_PAGE_SIZE = 50;

/** Most rows the search scan reads (newest first), as in search-queries.ts. */
const SEARCH_SCAN_LIMIT = 5000;

/** Ciphertext columns the search scan reads; decrypted per search, never cached as plaintext. */
interface SearchScanRow {
  readonly id: string;
  readonly nameEncrypted: string | null;
  readonly phoneEncrypted: string | null;
  readonly emailEncrypted: string | null;
  readonly addressEncrypted: string | null;
}

const searchScanCache = new CustomerScanCache<SearchScanRow>();

/**
 * Paginated customers list. The heavy former version fetched ALL customers with
 * three per-row correlated subqueries (~1.1s at 2.2k rows); this pages in SQL and
 * aggregates the equipment/request counts with a single grouped join (~3× faster).
 *
 * Search is over ENCRYPTED name/phone/email/address, which SQL can't filter — so
 * a search request decrypts + filters server-side across the matching set and
 * paginates the result (the heavy work stays on the server; only one page is
 * returned). The common no-search browse takes the fast LIMIT/OFFSET path.
 */
export async function getCustomers(
  organizationId: string,
  options?: {
    readonly includeArchived?: boolean;
    readonly page?: number;
    readonly limit?: number;
    readonly search?: string;
    readonly propertyType?: string | null;
    readonly customerType?: string | null;
    readonly membershipStatus?: string | null;
    readonly fieldpulseSynced?: boolean;
  },
): Promise<CustomerListPage> {
  const includeArchived = options?.includeArchived ?? false;
  const page = Math.max(1, options?.page ?? 1);
  const limit = Math.max(1, options?.limit ?? CUSTOMERS_PAGE_SIZE);
  const search = options?.search?.trim().toLowerCase() ?? "";
  const propertyType = options?.propertyType?.trim() || null;

  type CustomerType = (typeof customerTypeEnum.enumValues)[number];
  const validCustomerTypes: readonly string[] = customerTypeEnum.enumValues;
  const customerType =
    options?.customerType && validCustomerTypes.includes(options.customerType)
      ? (options.customerType as CustomerType)
      : null;

  type MembershipStatus = (typeof membershipStatusEnum.enumValues)[number];
  const validMembershipStatuses: readonly string[] = membershipStatusEnum.enumValues;
  const membershipStatus =
    options?.membershipStatus && validMembershipStatuses.includes(options.membershipStatus)
      ? (options.membershipStatus as MembershipStatus)
      : null;

  const fieldpulseSynced = options?.fieldpulseSynced ?? false;

  const conditions: SQL[] = [];
  // Erased ("[deleted]") rows carry no contact details, so they are hidden with
  // the archived ones and sorted last when "Show archived" is on.
  if (!includeArchived) {
    conditions.push(isNull(customers.archivedAt), isNull(customers.anonymizedAt));
  }
  if (propertyType) conditions.push(eq(customers.propertyType, propertyType));
  if (customerType) conditions.push(eq(customers.customerType, customerType));
  if (membershipStatus) conditions.push(eq(customers.membershipStatus, membershipStatus));
  if (fieldpulseSynced) conditions.push(isNotNull(customers.fieldpulseCustomerId));
  const whereClause = withTenant(customers, organizationId, ...conditions);

  // Distinct property types for the filter dropdown — cheap; runs in parallel
  // with the page/count so it adds no serial latency.
  const typesPromise = db
    .selectDistinct({ propertyType: customers.propertyType })
    .from(customers)
    .where(
      withTenant(customers, organizationId, isNotNull(customers.propertyType)),
    )
    .then((rows) =>
      rows
        .map((r) => r.propertyType)
        .filter((t): t is string => Boolean(t))
        .sort((a, b) => a.localeCompare(b)),
    );

  // The three count aggregates, shared by both query paths.
  const aggCols = {
    equipmentCount: sql<number>`count(distinct ${customerEquipment.id})::int`,
    requestCount: sql<number>`count(distinct ${serviceRequests.id})::int`,
    lastServiceDate: sql<string | null>`max(${serviceRequests.completedAt}) filter (where ${serviceRequests.completedAt} is not null)::text`,
  };

  type ListRow = {
    readonly id: string;
    readonly nameEncrypted: string | null;
    readonly phoneEncrypted: string | null;
    readonly emailEncrypted: string | null;
    readonly addressEncrypted: string | null;
    readonly propertyType: string | null;
    readonly createdAt: Date;
    readonly customerType: string;
    readonly membershipStatus: string;
    readonly fieldpulseCustomerId: string | null;
    readonly archivedAt: Date | null;
    readonly equipmentCount: number;
    readonly requestCount: number;
    readonly lastServiceDate: string | null;
  };

  const mapRow = (row: ListRow): CustomerListRecord => ({
    id: row.id,
    name: safeDecrypt(row.nameEncrypted),
    phone: safeDecrypt(row.phoneEncrypted),
    email: safeDecrypt(row.emailEncrypted),
    address: safeDecrypt(row.addressEncrypted),
    propertyType: row.propertyType,
    equipmentCount: row.equipmentCount ?? 0,
    requestCount: row.requestCount ?? 0,
    lastServiceDate: row.lastServiceDate,
    createdAt: row.createdAt.toISOString(),
    customerType: row.customerType,
    membershipStatus: row.membershipStatus,
    fieldpulseCustomerId: row.fieldpulseCustomerId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  });

  const customerCols = {
    id: customers.id,
    nameEncrypted: customers.nameEncrypted,
    phoneEncrypted: customers.phoneEncrypted,
    emailEncrypted: customers.emailEncrypted,
    addressEncrypted: customers.addressEncrypted,
    propertyType: customers.propertyType,
    createdAt: customers.createdAt,
    customerType: customers.customerType,
    membershipStatus: customers.membershipStatus,
    fieldpulseCustomerId: customers.fieldpulseCustomerId,
    archivedAt: customers.archivedAt,
    anonymizedAt: customers.anonymizedAt,
  } as const;

  // Newest first; erased rows (only present with "Show archived") go last.
  const listOrder = includeArchived
    ? [sql`${customers.anonymizedAt} is not null`, desc(customers.createdAt), desc(customers.id)]
    : [desc(customers.createdAt), desc(customers.id)];

  if (!search) {
    // Fast path. Pick the page's customer ids FIRST (indexed created_at order +
    // LIMIT), THEN aggregate over just those rows — the LIMIT sits below the
    // join, so we never join every customer. Page + total + types run together.
    const pageSub = db
      .select(customerCols)
      .from(customers)
      .where(whereClause)
      .orderBy(...listOrder)
      .limit(limit)
      .offset((page - 1) * limit)
      .as("page");

    const pagePromise = db
      .select({
        id: pageSub.id,
        nameEncrypted: pageSub.nameEncrypted,
        phoneEncrypted: pageSub.phoneEncrypted,
        emailEncrypted: pageSub.emailEncrypted,
        addressEncrypted: pageSub.addressEncrypted,
        propertyType: pageSub.propertyType,
        createdAt: pageSub.createdAt,
        customerType: pageSub.customerType,
        membershipStatus: pageSub.membershipStatus,
        fieldpulseCustomerId: pageSub.fieldpulseCustomerId,
        archivedAt: pageSub.archivedAt,
        anonymizedAt: pageSub.anonymizedAt,
        ...aggCols,
      })
      .from(pageSub)
      .leftJoin(customerEquipment, eq(customerEquipment.customerId, pageSub.id))
      .leftJoin(serviceRequests, eq(serviceRequests.customerId, pageSub.id))
      .groupBy(
        pageSub.id,
        pageSub.nameEncrypted,
        pageSub.phoneEncrypted,
        pageSub.emailEncrypted,
        pageSub.addressEncrypted,
        pageSub.propertyType,
        pageSub.createdAt,
        pageSub.customerType,
        pageSub.membershipStatus,
        pageSub.fieldpulseCustomerId,
        pageSub.archivedAt,
        pageSub.anonymizedAt,
      )
      .orderBy(sql`${pageSub.anonymizedAt} is not null`, desc(pageSub.createdAt));

    const countPromise = db
      .select({ n: count() })
      .from(customers)
      .where(whereClause);

    const [rows, countResult, propertyTypes] = await Promise.all([
      pagePromise,
      countPromise,
      typesPromise,
    ]);
    return {
      customers: rows.map(mapRow),
      total: countResult[0]?.n ?? 0,
      propertyTypes,
    };
  }

  // Search path: encrypted columns aren't SQL-searchable, so the matching set is
  // decrypted and filtered here. Reading every row's ciphertext is the slow part
  // (~800 KB at 2.6k customers), so the scan is cached per instance and only
  // re-read when a one-row fingerprint of the same filtered set changes. The
  // counts are then aggregated for the returned page only.
  const scanKey = JSON.stringify([
    organizationId,
    includeArchived,
    propertyType,
    customerType,
    membershipStatus,
    fieldpulseSynced,
  ]);
  const fingerprintPromise = db
    .select({
      fp: sql<string>`md5(coalesce(string_agg(${customers.id}::text || coalesce(${customers.nameEncrypted}, '') || coalesce(${customers.phoneEncrypted}, '') || coalesce(${customers.emailEncrypted}, '') || coalesce(${customers.addressEncrypted}, '') || coalesce(${customers.anonymizedAt}::text, ''), ',' order by ${customers.createdAt} desc, ${customers.id} desc), ''))`,
    })
    .from(customers)
    .where(whereClause);
  const [fingerprintRows, propertyTypes] = await Promise.all([
    fingerprintPromise,
    typesPromise,
  ]);
  const fingerprint = fingerprintRows[0]?.fp ?? "";

  let scan = searchScanCache.get(scanKey, fingerprint);
  if (!scan) {
    scan = await db
      .select({
        id: customers.id,
        nameEncrypted: customers.nameEncrypted,
        phoneEncrypted: customers.phoneEncrypted,
        emailEncrypted: customers.emailEncrypted,
        addressEncrypted: customers.addressEncrypted,
      })
      .from(customers)
      .where(whereClause)
      .orderBy(...listOrder)
      .limit(SEARCH_SCAN_LIMIT);
    searchScanCache.set(scanKey, fingerprint, scan);
  }

  const matchedIds = scan
    .filter((row) =>
      customerMatchesSearch(
        {
          name: safeDecrypt(row.nameEncrypted),
          phone: safeDecrypt(row.phoneEncrypted),
          email: safeDecrypt(row.emailEncrypted),
          address: safeDecrypt(row.addressEncrypted),
        },
        search,
      ),
    )
    .map((row) => row.id);
  const start = (page - 1) * limit;
  const pageIds = matchedIds.slice(start, start + limit);
  if (pageIds.length === 0) {
    return { customers: [], total: matchedIds.length, propertyTypes };
  }

  const pageRows = await db
    .select({ ...customerCols, ...aggCols })
    .from(customers)
    .leftJoin(customerEquipment, eq(customerEquipment.customerId, customers.id))
    .leftJoin(serviceRequests, eq(serviceRequests.customerId, customers.id))
    .where(withTenant(customers, organizationId, inArray(customers.id, pageIds)))
    .groupBy(customers.id);
  const byId = new Map(pageRows.map((row) => [row.id, row]));
  return {
    customers: pageIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof pageRows)[number] => row !== undefined)
      .map(mapRow),
    total: matchedIds.length,
    propertyTypes,
  };
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

  const [equipmentRows, noteRows, followUpRows, historyRows, requestCountRows, lastServiceRows] =
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
          fieldpulseCommentId: customerNotes.fieldpulseCommentId,
        })
        .from(customerNotes)
        .leftJoin(users, and(eq(customerNotes.authorId, users.id), eq(users.organizationId, organizationId)))
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
        .leftJoin(users, and(eq(followUps.assignedTo, users.id), eq(users.organizationId, organizationId)))
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

      // requestCount folded in to avoid a sequential round trip after the block.
      db
        .select({ value: count() })
        .from(serviceRequests)
        .where(
          withTenant(
            serviceRequests,
            organizationId,
            eq(serviceRequests.customerId, customerId),
          ),
        ),

      // lastServiceDate — the last completed service, matching the list aggregate.
      db
        .select({ value: sql<string | null>`max(${serviceRequests.completedAt}) filter (where ${serviceRequests.completedAt} is not null)::text` })
        .from(serviceRequests)
        .where(
          withTenant(
            serviceRequests,
            organizationId,
            eq(serviceRequests.customerId, customerId),
          ),
        ),
    ]);

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
    requestCount: requestCountRows[0]?.value ?? 0,
    lastServiceDate: lastServiceRows[0]?.value ?? null,
    customerType: row.customerType,
    membershipStatus: row.membershipStatus,
    fieldpulseCustomerId: row.fieldpulseCustomerId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    // Whether a self-service portal link is currently active. Boolean only — the
    // hash (token material) is never sent to the client.
    portalActive: Boolean(row.portalTokenHash),
    fieldpulseCustomFields: row.fieldpulseCustomFields ?? null,
    isTaxExempt: row.isTaxExempt ?? null,
    billingAddress: safeDecrypt(row.billingAddressEncrypted ?? null),
    fieldpulseData: (row.fieldpulseData as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    equipment: equipmentRows.map((e) => ({
      id: e.id,
      equipmentType: e.equipmentType,
      make: e.make,
      model: e.model,
      serialNumber: e.serialNumber,
      installDate: e.installDate?.toISOString() ?? null,
      warrantyExpiration: e.warrantyExpiration?.toISOString() ?? null,
      warrantyType: e.warrantyType,
      warrantyProvider: e.warrantyProvider,
      locationInHome: e.locationInHome,
      notes: e.notes,
      fieldpulseAssetId: e.fieldpulseAssetId ?? null,
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
      fieldpulseCommentId: n.fieldpulseCommentId ?? null,
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
  // Populate the blind-index hashes so admin-created customers participate in
  // the same per-org uniqueness as chat-created ones (no split-brain dupes).
  const { emailHash, phoneHash } = computeContactHashes({
    email: input.email ?? null,
    phone: input.phone ?? null,
  });

  const [created] = await db
    .insert(customers)
    .values({
      organizationId,
      nameEncrypted: encrypt(input.name),
      phoneEncrypted: input.phone ? encrypt(input.phone) : null,
      emailEncrypted: input.email ? encrypt(input.email) : null,
      addressEncrypted: input.address ? encrypt(input.address) : null,
      emailHash,
      phoneHash,
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
    customerType: created.customerType ?? 'residential',
    membershipStatus: created.membershipStatus ?? 'none',
    fieldpulseCustomerId: created.fieldpulseCustomerId ?? null,
    archivedAt: null,
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
    warrantyType: input.warrantyType ?? null,
    warrantyProvider: input.warrantyProvider ?? null,
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
  // Verify a supplied assignee belongs to THIS org before storing it — a
  // caller-supplied id was trusted verbatim, so a follow-up could be assigned to
  // (and, via the org-scoped join, surface the name of) a user in another tenant.
  let assignedTo: string | null = null;
  if (input.assignedTo) {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.assignedTo), eq(users.organizationId, organizationId)))
      .limit(1);
    if (!member) {
      throw new Error("Assignee is not a member of this organization");
    }
    assignedTo = member.id;
  }
  await db.insert(followUps).values({
    customerId,
    organizationId,
    assignedTo,
    reason: input.reason,
    dueDate: new Date(input.dueDate),
    status: "pending",
  });
}

/**
 * Placeholder used for the NOT-NULL `customers.name_encrypted` column when a
 * customer record is created without a known name (e.g. an anonymous service
 * request that only provided a phone number).
 */
const UNKNOWN_CUSTOMER_NAME = "Unknown";

export interface FindOrCreateCustomerInput {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
}

export function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Computes the blind-index hashes to store alongside a customer's encrypted
 * email/phone. Returns null for a field that is absent. Centralized so the
 * write path (customer upsert) and the read path (lookup) always normalize and
 * hash identically.
 */
export function computeContactHashes(input: {
  readonly email: string | null;
  readonly phone: string | null;
}): { readonly emailHash: string | null; readonly phoneHash: string | null } {
  const normalizedEmail = normalizeEmail(input.email);
  const normalizedPhone = normalizePhone(input.phone);
  return {
    emailHash: normalizedEmail ? blindIndex(normalizedEmail) : null,
    phoneHash: normalizedPhone ? blindIndex(normalizedPhone) : null,
  };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Every row in the org that answers this email or phone, ordered by the pick
 * rules (see {@link pickCustomerMatch}) and capped.
 *
 * One query, not two: a contact can now legitimately answer with several rows
 * (FieldPulse-linked rows share contacts), so email and phone are matched
 * together and the winner is chosen by rank rather than by query order. Rule 1
 * (never resolve an erased row) is in the `WHERE`; rules 2-7 are in the
 * `ORDER BY`, which is what makes the `LIMIT` safe — it can only drop rows that
 * would have ranked below the winner.
 *
 * Exported because SMS consent resolves the SAME candidate set with a DIFFERENT
 * order (STOP fans out, START skips the do-not-service rule): the ordering may
 * differ per direction, the candidate set must not.
 *
 * The default LIMIT is a winner-selection guard and is only safe because the
 * ORDER BY ranks the winner first. A fan-out consumer (SMS STOP) needs the
 * WHOLE set — it passes `{ limit: null }` to lift the cap, because a capped
 * STOP would silence 50 businesses and keep texting the 51st.
 */
export async function findCustomerMatchCandidates(
  organizationId: string,
  input: { readonly email: string | null; readonly phone: string | null },
  opts?: { readonly limit?: number | null },
): Promise<CustomerMatchCandidate[]> {
  const targetEmail = normalizeEmail(input.email);
  const targetPhone = normalizePhone(input.phone);

  const emailHash = targetEmail ? blindIndex(targetEmail) : null;
  const phoneHash = targetPhone ? blindIndex(targetPhone) : null;

  const contactConditions: SQL[] = [];
  if (emailHash) contactConditions.push(eq(customers.emailHash, emailHash));
  if (phoneHash) contactConditions.push(eq(customers.phoneHash, phoneHash));
  if (contactConditions.length === 0) return [];
  const contactMatch = or(...contactConditions) ?? contactConditions[0];

  // A NULL hash is never equal to anything, so an absent email can only ever
  // produce a 'phone' match.
  const emailMatched = sql`${customers.emailHash} = ${emailHash}`;
  const lastActivityAt = sql<
    string | null
  >`(select max(${serviceRequests.createdAt}) from ${serviceRequests} where ${serviceRequests.customerId} = ${customers.id})`;

  const query = db
    .select({
      id: customers.id,
      matchedOn: sql<"email" | "phone">`case when ${emailMatched} then 'email' else 'phone' end`,
      anonymizedAt: customers.anonymizedAt,
      archivedAt: customers.archivedAt,
      doNotService: customers.doNotService,
      createdAt: customers.createdAt,
      lastActivityAt,
    })
    .from(customers)
    .where(
      withTenant(
        customers,
        organizationId,
        contactMatch,
        customerMatchCandidatePredicate(),
      ),
    )
    .orderBy(
      desc(customers.doNotService),
      sql`case when ${emailMatched} then 0 else 1 end`,
      sql`case when ${customers.archivedAt} is null then 0 else 1 end`,
      sql`${lastActivityAt} desc nulls last`,
      desc(customers.createdAt),
      asc(customers.id),
    );
  const rows =
    opts?.limit === null
      ? await query
      : await query.limit(opts?.limit ?? CUSTOMER_MATCH_CANDIDATE_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    matchedOn: row.matchedOn === "email" ? "email" : "phone",
    anonymizedAt: toDate(row.anonymizedAt),
    archivedAt: toDate(row.archivedAt),
    doNotService: Boolean(row.doNotService),
    createdAt: toDate(row.createdAt),
    lastActivityAt: toDate(row.lastActivityAt),
  }));
}

/**
 * Decrypt-and-compare fallback for legacy rows written before the hash columns
 * existed (both hashes still NULL). Only fires when the indexed path found
 * nothing.
 *
 * Narrowed to `fieldpulse_customer_id IS NULL`: contactless FieldPulse imports
 * also satisfy "both hashes NULL", and none of them carry encrypted contact
 * either, so excluding them keeps this scan unreachable in practice by
 * construction as the FP population grows.
 *
 * This scan deliberately bypasses the pick order — it is a first-match loop
 * over a pre-migration population, not an identity ranking.
 */
async function findLegacyCustomerMatch(
  organizationId: string,
  targetEmail: string | null,
  targetPhone: string | null,
): Promise<CustomerMatch | null> {
  const legacy = await db
    .select({
      id: customers.id,
      emailEncrypted: customers.emailEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      emailHash: customers.emailHash,
      phoneHash: customers.phoneHash,
      doNotService: customers.doNotService,
    })
    .from(customers)
    .where(
      withTenant(
        customers,
        organizationId,
        sql`(${customers.emailHash} IS NULL AND ${customers.phoneHash} IS NULL AND ${customers.fieldpulseCustomerId} IS NULL)`,
      ),
    );

  if (targetEmail) {
    for (const row of legacy) {
      const decryptedEmail = normalizeEmail(safeDecrypt(row.emailEncrypted));
      if (decryptedEmail && decryptedEmail === targetEmail) {
        return {
          id: row.id,
          ambiguous: false,
          doNotService: Boolean(row.doNotService),
        };
      }
    }
  }

  if (targetPhone) {
    for (const row of legacy) {
      const decryptedPhone = normalizePhone(safeDecrypt(row.phoneEncrypted));
      if (decryptedPhone && decryptedPhone === targetPhone) {
        return {
          id: row.id,
          ambiguous: false,
          doNotService: Boolean(row.doNotService),
        };
      }
    }
  }

  return null;
}

async function resolveCustomerMatch(
  organizationId: string,
  input: { readonly email: string | null; readonly phone: string | null },
): Promise<{
  readonly match: CustomerMatch | null;
  readonly candidates: readonly CustomerMatchCandidate[];
}> {
  const targetEmail = normalizeEmail(input.email);
  const targetPhone = normalizePhone(input.phone);

  if (!targetEmail && !targetPhone) return { match: null, candidates: [] };

  const candidates = await findCustomerMatchCandidates(organizationId, input);
  const picked = pickCustomerMatch(candidates);
  if (picked) return { match: picked, candidates };

  const legacy = await findLegacyCustomerMatch(
    organizationId,
    targetEmail,
    targetPhone,
  );
  return { match: legacy, candidates };
}

/**
 * Finds an existing customer id for the org by email (case-insensitive, trimmed)
 * or phone (non-digits stripped). Returns null when nothing matches.
 *
 * Kept as `string | null` for the callers that only want an id; the callers that
 * must react to an ambiguous cluster use {@link findCustomerMatchByContact}.
 */
export async function findCustomerIdByContact(
  organizationId: string,
  input: { readonly email: string | null; readonly phone: string | null },
): Promise<string | null> {
  const { match } = await resolveCustomerMatch(organizationId, input);
  return match?.id ?? null;
}

/**
 * Same lookup as {@link findCustomerIdByContact}, exposing the full result so
 * callers can tell a confident identity from an ambiguous cluster.
 *
 * Writes the forensic row for the one case a human needs to see: an ambiguous
 * cluster whose fail-closed winner is do-not-service. The three refusal sites
 * never receive the flag (by design — they re-read do-not-service from the id),
 * so the resolver records it instead of threading a flag through them. This
 * fires on LOOKUP, not on refusal — over-logging beats invisibility.
 * Best-effort: the audit insert must never fail an identity lookup.
 */
export async function findCustomerMatchByContact(
  organizationId: string,
  input: { readonly email: string | null; readonly phone: string | null },
): Promise<CustomerMatch | null> {
  const { match, candidates } = await resolveCustomerMatch(
    organizationId,
    input,
  );

  if (match?.ambiguous && match.doNotService) {
    try {
      await db.insert(auditLog).values({
        organizationId,
        actorType: "system",
        action: "ambiguous_do_not_service_refusal",
        entity: "customer",
        entityId: match.id,
        // Ids and counts only — never contact values (AGENTS.md).
        details: JSON.stringify({
          candidateCount: candidates.length,
          candidateIds: candidates.map((candidate) => candidate.id),
        }),
        ipAddress: null,
      });
    } catch {
      // Swallowed on purpose, and not logged: this module is imported by the
      // intake path and by pure-helper suites that do not mock the logger. The
      // lookup result is what the caller needs; the trail is a nicety.
    }
  }

  return match;
}

/**
 * Atomically resolves the canonical customer id for a contact, creating the
 * row if it doesn't exist. Safe under concurrency: when two callers race for
 * the same email/phone, the unique blind-index constraint forces a conflict
 * and `onConflictDoUpdate` returns the SAME existing id to both — so they can
 * never create duplicate customer rows. (A plain find-then-insert has a
 * TOCTOU window where both find nothing and both insert.)
 *
 * The conflict target is the email-hash index when an email is present,
 * otherwise the phone-hash index. A no-op `updatedAt` touch is used as the
 * conflict action purely so RETURNING yields the surviving row's id.
 *
 * Edge case: ON CONFLICT can arbiter only ONE index. If a row carries both an
 * email and a phone and two submits race on the SAME phone but DIFFERENT email
 * (so the email arbiter doesn't catch it), the phone unique index raises an
 * uncaught unique violation, surfacing as a 500 the caller can retry. This is
 * rare (findCustomerIdByContact, run just above, checks both keys first) and
 * never corrupts data or creates a duplicate — it just fails that one request.
 */
export async function upsertCustomerByContact(
  organizationId: string,
  input: FindOrCreateCustomerInput,
): Promise<string> {
  // Dedupe hashes are computed from the RAW input — computeContactHashes
  // normalizes internally (lower-cased email, digits-only phone), so formatting
  // the phone for display below cannot change which customer this resolves to.
  const { emailHash, phoneHash } = computeContactHashes({
    email: input.email,
    phone: input.phone,
  });

  // Sanitize the values we ENCRYPT for display/dispatch: capitalize the name,
  // format the phone, tidy the address. The chat path already sanitizes via
  // buildExtraction, but a direct POST to /api/session/confirm reaches here
  // without that, so this is the authoritative persistence-boundary pass.
  const values = {
    organizationId,
    nameEncrypted: encrypt(input.name ? sanitizeName(input.name) : UNKNOWN_CUSTOMER_NAME),
    phoneEncrypted: input.phone ? encrypt(sanitizePhone(input.phone)) : null,
    emailEncrypted: input.email ? encrypt(sanitizeEmail(input.email)) : null,
    addressEncrypted: input.address ? encrypt(sanitizeAddress(input.address)) : null,
    emailHash,
    phoneHash,
  };

  // No contact key at all — nothing to dedupe on, just insert.
  if (!emailHash && !phoneHash) {
    const [created] = await db
      .insert(customers)
      .values(values)
      .returning({ id: customers.id });
    if (!created) throw new Error("Failed to create customer");
    return created.id;
  }

  // If we already know the customer (incl. legacy non-hashed rows), reuse it.
  const existing = await findCustomerMatchByContact(organizationId, {
    email: input.email,
    phone: input.phone,
  });
  if (existing) {
    // A returning customer who was archived is reactivated by their new
    // booking — clearing archived_at brings them back into the active list.
    //
    // Gated, because the pick ranks do-not-service first: without this an
    // ambiguous or blocked resolution would let every refused intake attempt
    // resurrect a tombstone into the active customer list. The id is still
    // returned either way, so the downstream do-not-service re-read is
    // unaffected.
    if (!existing.ambiguous && !existing.doNotService) {
      await db
        .update(customers)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(
          withTenant(
            customers,
            organizationId,
            eq(customers.id, existing.id),
            sql`${customers.archivedAt} IS NOT NULL`,
          ),
        );
    }
    return existing.id;
  }

  // Pick ONE arbiter index for ON CONFLICT — email when present (the stronger
  // identity key), else phone. Postgres can only infer a PARTIAL unique index
  // when the conflict spec repeats the index predicate, so targetWhere is
  // textually identical to the native-only index predicate in schema.ts.
  // Without it Postgres raises "no unique or exclusion constraint matching the
  // ON CONFLICT specification" at runtime. Every row this function inserts has
  // fieldpulse_customer_id = NULL, so both racers are inside that index's
  // population and one must lose — the race-safety mechanism is preserved.
  const onEmail = Boolean(emailHash);
  const conflictTarget = onEmail
    ? [customers.organizationId, customers.emailHash]
    : [customers.organizationId, customers.phoneHash];
  const conflictPredicate = onEmail
    ? sql`${customers.emailHash} IS NOT NULL AND ${customers.fieldpulseCustomerId} IS NULL`
    : sql`${customers.phoneHash} IS NOT NULL AND ${customers.fieldpulseCustomerId} IS NULL`;

  const [row] = await db
    .insert(customers)
    .values(values)
    .onConflictDoUpdate({
      target: conflictTarget,
      targetWhere: conflictPredicate,
      set: {
        updatedAt: new Date(),
        // Reactivate an archived match on conflict (a returning customer
        // rebooking). This path is reached only when the find above found
        // nothing and the INSERT then lost a race, so the conflicting row
        // appeared concurrently and is by construction the only row on that
        // hash — unambiguous. The one remaining gate term has no JS to live in
        // here, so it goes in the SET: a blocked row keeps its archived_at.
        archivedAt: sql`CASE WHEN ${customers.doNotService} THEN ${customers.archivedAt} ELSE NULL END`,
      },
    })
    .returning({ id: customers.id });

  if (!row) throw new Error("Failed to upsert customer");
  return row.id;
}

/**
 * Finds an existing customer for the org (see {@link findCustomerIdByContact})
 * or creates a new one, returning its id. Delegates to the atomic, race-safe
 * {@link upsertCustomerByContact}.
 */
export async function findOrCreateCustomer(
  organizationId: string,
  input: FindOrCreateCustomerInput,
): Promise<string> {
  return upsertCustomerByContact(organizationId, input);
}

/**
 * Deletes a customer and its dependent CRM records for the given org.
 *
 * Returns false if no such customer exists in the org. Otherwise deletes
 * dependent rows in FK-dependency order (service_history, follow_ups,
 * customer_notes, customer_equipment), detaches service_requests by nulling
 * their customer_id (so the request/conversation history survives), then
 * deletes the customer row — and returns true.
 *
 * The dependent writes — and an audit-log entry recording who deleted what —
 * are issued via `db.batch`, which the neon-http driver executes as a single
 * non-interactive (atomic) transaction. The neon-http driver does not support
 * Drizzle's interactive `db.transaction()` API (it throws "No transactions
 * support in neon-http driver").
 */
export async function deleteCustomer(
  organizationId: string,
  customerId: string,
  actor?: { readonly userId?: string | null; readonly ipAddress?: string | null },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!existing) return false;

  await db.batch([
    db
      .delete(serviceHistory)
      .where(
        withTenant(
          serviceHistory,
          organizationId,
          eq(serviceHistory.customerId, customerId),
        ),
      ),
    db
      .delete(followUps)
      .where(
        withTenant(
          followUps,
          organizationId,
          eq(followUps.customerId, customerId),
        ),
      ),
    db
      .delete(customerNotes)
      .where(
        withTenant(
          customerNotes,
          organizationId,
          eq(customerNotes.customerId, customerId),
        ),
      ),
    db
      .delete(customerEquipment)
      .where(
        withTenant(
          customerEquipment,
          organizationId,
          eq(customerEquipment.customerId, customerId),
        ),
      ),
    db
      .update(serviceRequests)
      .set({ customerId: null })
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.customerId, customerId),
        ),
      ),
    // Tags are polymorphic (no FK): clear them for the customer and its
    // locations before the customer row goes. Contacts cascade by FK.
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "customer"), eq(entityTags.entityId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "location"),
      inArray(entityTags.entityId, db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.customerId, customerId)))))),
    db
      .delete(customers)
      .where(
        withTenant(customers, organizationId, eq(customers.id, customerId)),
      ),
    db.insert(auditLog).values({
      organizationId,
      userId: actor?.userId ?? null,
      action: "customer_deleted",
      entity: "customers",
      entityId: customerId,
      ipAddress: actor?.ipAddress ?? null,
    }),
  ]);

  return true;
}

/**
 * Archives (soft-deletes) a customer: sets archived_at so the row drops out of
 * the default list but is fully retained and reversible. Unlike deleteCustomer,
 * no related rows are touched. Idempotent on an already-archived row (still
 * returns true). Returns false only when the customer doesn't exist in the org.
 */
export async function archiveCustomer(
  organizationId: string,
  customerId: string,
  actor?: { readonly userId?: string | null; readonly ipAddress?: string | null },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: customers.id, archivedAt: customers.archivedAt })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!existing) return false;
  // Already archived — no-op (don't re-stamp or write a duplicate audit row).
  if (existing.archivedAt !== null) return true;

  await db.batch([
    db
      .update(customers)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        withTenant(customers, organizationId, eq(customers.id, customerId)),
      ),
    db.insert(auditLog).values({
      organizationId,
      userId: actor?.userId ?? null,
      action: "customer_archived",
      entity: "customers",
      entityId: customerId,
      ipAddress: actor?.ipAddress ?? null,
    }),
  ]);

  return true;
}

/**
 * The native customer a create clashed with on email or phone (the per-org
 * native unique indexes), so the 409 can link to it — including an archived
 * row the default list hides. Email wins over phone, like the match order.
 * Returns ids and the archived flag only; never contact values.
 */
export async function findNativeContactClash(
  organizationId: string,
  input: { readonly email: string | null; readonly phone: string | null },
): Promise<{ readonly id: string; readonly archived: boolean } | null> {
  const { emailHash, phoneHash } = computeContactHashes(input);
  const matchers: SQL[] = [];
  if (emailHash) matchers.push(eq(customers.emailHash, emailHash));
  if (phoneHash) matchers.push(eq(customers.phoneHash, phoneHash));
  if (matchers.length === 0) return null;
  const rows = await db
    .select({
      id: customers.id,
      archivedAt: customers.archivedAt,
      emailMatched: emailHash
        ? sql<boolean>`${customers.emailHash} = ${emailHash}`
        : sql<boolean>`false`,
    })
    .from(customers)
    .where(
      withTenant(
        customers,
        organizationId,
        isNull(customers.fieldpulseCustomerId),
        isNull(customers.anonymizedAt),
        or(...matchers) ?? sql`false`,
      ),
    )
    .limit(2);
  const pick = rows.find((r) => r.emailMatched) ?? rows[0];
  return pick ? { id: pick.id, archived: pick.archivedAt !== null } : null;
}

/**
 * Restores an archived customer (clears archived_at) so it shows in the
 * default list again. Mirror of {@link archiveCustomer}: idempotent on an
 * active row (returns true, no write), false only when the customer isn't in
 * the org. An erased row stays erased; unarchiving only un-hides it.
 */
export async function unarchiveCustomer(
  organizationId: string,
  customerId: string,
  actor?: { readonly userId?: string | null; readonly ipAddress?: string | null },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: customers.id, archivedAt: customers.archivedAt })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!existing) return false;
  if (existing.archivedAt === null) return true;

  await db.batch([
    db
      .update(customers)
      .set({ archivedAt: null, updatedAt: sql`now()` })
      .where(
        withTenant(customers, organizationId, eq(customers.id, customerId)),
      ),
    db.insert(auditLog).values({
      organizationId,
      userId: actor?.userId ?? null,
      action: "customer_unarchived",
      entity: "customers",
      entityId: customerId,
      ipAddress: actor?.ipAddress ?? null,
    }),
  ]);

  return true;
}

/**
 * Updates a customer's contact/property fields within an org.
 *
 * PII columns are re-encrypted (random IV) and, when email/phone change, the
 * deterministic blind-index hashes are recomputed so the row keeps deduping
 * correctly. Before writing a new email/phone we check the corresponding
 * blind-index does not already belong to a DIFFERENT customer in the org —
 * returning `contact_conflict` instead of letting the partial unique index
 * raise a raw 500.
 *
 * Both the check and the edited row are narrowed to the NATIVE population
 * (`fieldpulse_customer_id IS NULL`), which is the only population the unique
 * index still covers: recording one accounts-payable email on a second
 * FieldPulse-linked business is a legitimate state, not a conflict. The check
 * is a check-then-write (not fully atomic — neon-http has no transactions), so
 * the write itself is wrapped: a concurrent edit that slips past the check hits
 * the index and is mapped to the same `contact_conflict` rather than a 500.
 *
 * Only the fields present on `input` are touched; `undefined` leaves a column
 * as-is, `null` clears it (except `name`, which is NOT NULL). The audit entry
 * records WHICH fields changed, never their values.
 */
export async function updateCustomerContact(
  organizationId: string,
  customerId: string,
  input: UpdateCustomerInput,
  actor?: { readonly userId?: string | null; readonly ipAddress?: string | null },
): Promise<UpdateCustomerResult> {
  const [existing] = await db
    .select({
      id: customers.id,
      emailHash: customers.emailHash,
      phoneHash: customers.phoneHash,
      fieldpulseCustomerId: customers.fieldpulseCustomerId,
    })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!existing) return { ok: false, reason: "not_found" };

  // Only a native row can violate the native-only contact uniques, so only a
  // native row needs the clash check at all.
  const editedRowIsNative = !existing.fieldpulseCustomerId;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changedFields: string[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0) {
      // name is NOT NULL — refuse to blank it. Treat as a no-op for that field.
    } else {
      set.nameEncrypted = encrypt(name);
      changedFields.push("name");
    }
  }

  if (input.email !== undefined) {
    const normalized = normalizeEmail(input.email);
    const newHash = normalized ? blindIndex(normalized) : null;
    if (editedRowIsNative && newHash && newHash !== existing.emailHash) {
      const [clash] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(
          withTenant(
            customers,
            organizationId,
            eq(customers.emailHash, newHash),
            ne(customers.id, customerId),
            isNull(customers.fieldpulseCustomerId),
          ),
        )
        .limit(1);
      if (clash) return { ok: false, reason: "contact_conflict" };
    }
    set.emailEncrypted = input.email ? encrypt(input.email) : null;
    set.emailHash = newHash;
    changedFields.push("email");
  }

  if (input.phone !== undefined) {
    const normalized = normalizePhone(input.phone);
    const newHash = normalized ? blindIndex(normalized) : null;
    if (editedRowIsNative && newHash && newHash !== existing.phoneHash) {
      const [clash] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(
          withTenant(
            customers,
            organizationId,
            eq(customers.phoneHash, newHash),
            ne(customers.id, customerId),
            isNull(customers.fieldpulseCustomerId),
          ),
        )
        .limit(1);
      if (clash) return { ok: false, reason: "contact_conflict" };
    }
    set.phoneEncrypted = input.phone ? encrypt(input.phone) : null;
    set.phoneHash = newHash;
    changedFields.push("phone");
  }

  if (input.address !== undefined) {
    set.addressEncrypted = input.address ? encrypt(input.address) : null;
    changedFields.push("address");
  }

  if (input.propertyType !== undefined) {
    set.propertyType = input.propertyType;
    changedFields.push("propertyType");
  }

  if (input.propertySqft !== undefined) {
    set.propertySqft = input.propertySqft;
    changedFields.push("propertySqft");
  }

  if (input.notes !== undefined) {
    set.notes = input.notes;
    changedFields.push("notes");
  }

  // Nothing actually changed (e.g. a submit with no edits, or only a blank
  // name) — skip the write and the audit row so we don't bump `updatedAt` or
  // pollute the trail with a phantom "customer_updated" event.
  if (changedFields.length === 0) {
    return { ok: true };
  }

  try {
    await db
      .update(customers)
      .set(set)
      .where(withTenant(customers, organizationId, eq(customers.id, customerId)));
  } catch (error: unknown) {
    // The clash check above is a check-then-set with no transaction around it,
    // so two concurrent edits can both pass it and the index decides. Report
    // the loser the same way the pre-check does instead of a raw 500.
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "contact_conflict" };
    }
    throw error;
  }

  await logAudit({
    organizationId,
    userId: actor?.userId ?? "system",
    action: "customer_updated",
    entity: "customers",
    entityId: customerId,
    details: JSON.stringify({ fields: changedFields }),
    ipAddress: actor?.ipAddress ?? null,
  });

  return { ok: true };
}

/**
 * Marks a pending follow-up complete for the org. Status-guarded on
 * `pending` so a double-click (or a race) only transitions — and audits — once;
 * a follow-up already completed/cancelled matches zero rows and returns false.
 */
export async function completeFollowUp(
  organizationId: string,
  followUpId: string,
  actor?: { readonly userId?: string | null },
): Promise<boolean> {
  const [updated] = await db
    .update(followUps)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      withTenant(
        followUps,
        organizationId,
        eq(followUps.id, followUpId),
        eq(followUps.status, "pending"),
      ),
    )
    .returning({ id: followUps.id });

  if (!updated) return false;

  await logAudit({
    organizationId,
    userId: actor?.userId ?? "system",
    action: "follow_up_completed",
    entity: "follow_ups",
    entityId: followUpId,
  });

  return true;
}
