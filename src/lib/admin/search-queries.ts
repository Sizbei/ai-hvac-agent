import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  serviceRequests,
  estimates,
  invoices,
  pricebookItems,
  customerSessions,
  messages,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { invoiceRef } from "@/lib/admin/invoice-collectible";
import { issueTypeLabel, humanizeCode } from "@/lib/admin/request-labels";
import { notStandInSession } from "@/lib/admin/stand-in-session";
import { sessionContactMatches } from "@/lib/admin/session-contact-search";
import {
  channelTitle,
  conversationTitle,
  customerNameFromMetadata,
  needsAction,
  shortConversationId,
} from "@/lib/admin/conversation-display";
import { ERASED_PLACEHOLDER } from "@/lib/admin/report-format";

export type SearchResult = {
  readonly type:
    | "customer"
    | "invoice"
    | "job"
    | "conversation"
    | "estimate"
    | "pricebook"
    | "staff";
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly href: string;
  readonly syncedSource?: "fieldpulse" | "hcp" | null;
};

/** Max results per entity type returned from search. */
const RESULTS_PER_TYPE = 8;

/**
 * Safety cap for entities that need app-side decrypt-and-filter (encrypted
 * columns can't be ILIKE'd in Postgres). Reduced from 5000 → 1500 to bound
 * per-keystroke decrypt cost; the 300ms client debounce + 2-char minimum
 * already gate frequency. Scans are ordered newest-first, so the most-recent
 * 1500 records are always searched (tradeoff: very old records in large orgs
 * may be missed; acceptable given the debounce/min-char guards).
 */
const SCAN_LIMIT_CUSTOMERS = 1500;
const SCAN_LIMIT_INVOICES = 1500;
const SCAN_LIMIT_ESTIMATES = 1500;

function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** ILIKE "contains" pattern with the LIKE metacharacters escaped. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** A decrypted customer name fit to show (not blank, not an erased placeholder). */
function displayableName(...encrypted: (string | null)[]): string | null {
  for (const value of encrypted) {
    const name = safeDecrypt(value)?.trim();
    if (name && name !== ERASED_PLACEHOLDER) return name;
  }
  return null;
}

export async function searchCustomers(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const term = q.toLowerCase();
  const rows = await db
    .select({
      id: customers.id,
      nameEncrypted: customers.nameEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      emailEncrypted: customers.emailEncrypted,
      fieldpulseCustomerId: customers.fieldpulseCustomerId,
    })
    .from(customers)
    .where(withTenant(customers, organizationId))
    .orderBy(desc(customers.createdAt))
    .limit(SCAN_LIMIT_CUSTOMERS);

  const results: SearchResult[] = [];
  for (const row of rows) {
    const name = safeDecrypt(row.nameEncrypted);
    const phone = safeDecrypt(row.phoneEncrypted);
    const email = safeDecrypt(row.emailEncrypted);
    const matches =
      (name?.toLowerCase().includes(term) ?? false) ||
      (phone?.toLowerCase().includes(term) ?? false) ||
      (email?.toLowerCase().includes(term) ?? false);
    if (!matches) continue;
    results.push({
      type: "customer",
      id: row.id,
      title: name ?? "Unknown",
      subtitle: phone ?? email ?? "",
      href: `/admin/customers/${row.id}`,
      syncedSource: row.fieldpulseCustomerId ? "fieldpulse" : null,
    });
    if (results.length >= RESULTS_PER_TYPE) break;
  }
  return results;
}

export async function searchInvoices(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const term = q.toLowerCase();
  const rows = await db
    .select({
      id: invoices.id,
      state: invoices.state,
      totalCents: invoices.totalCents,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId))
    .orderBy(desc(invoices.createdAt))
    .limit(SCAN_LIMIT_INVOICES);

  const results: SearchResult[] = [];
  for (const row of rows) {
    const ref = invoiceRef(row.id);
    const matches =
      ref.toLowerCase().includes(term) ||
      (row.fieldpulseInvoiceId?.toLowerCase().includes(term) ?? false);
    if (!matches) continue;
    results.push({
      type: "invoice",
      id: row.id,
      title: ref,
      subtitle: `${humanizeCode(row.state)} · ${formatCents(row.totalCents)}`,
      href: `/admin/invoices/${row.id}`,
      syncedSource: row.fieldpulseInvoiceId
        ? "fieldpulse"
        : row.hcpInvoiceId
          ? "hcp"
          : null,
    });
    if (results.length >= RESULTS_PER_TYPE) break;
  }
  return results;
}

export async function searchJobs(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      status: serviceRequests.status,
      requestNameEncrypted: serviceRequests.customerNameEncrypted,
      customerNameEncrypted: customers.nameEncrypted,
    })
    .from(serviceRequests)
    // FieldPulse-imported requests keep the name only on the customer row.
    .leftJoin(
      customers,
      and(
        eq(customers.id, serviceRequests.customerId),
        eq(customers.organizationId, organizationId),
      ),
    )
    .where(
      and(
        withTenant(serviceRequests, organizationId),
        or(
          ilike(serviceRequests.issueType, `%${q}%`),
          ilike(serviceRequests.referenceNumber, `%${q}%`),
        ),
      ),
    )
    .limit(RESULTS_PER_TYPE);

  return rows.map((row) => {
    const reference = row.referenceNumber ?? `Request ${row.id.slice(0, 8).toUpperCase()}`;
    const name = displayableName(row.requestNameEncrypted, row.customerNameEncrypted);
    return {
      type: "job" as const,
      id: row.id,
      title: name ?? reference,
      subtitle: name
        ? `${reference} · ${issueTypeLabel(row.issueType)}`
        : issueTypeLabel(row.issueType),
      // There is no /admin/requests/[id] page; the list opens the sheet.
      href: `/admin/requests?request=${row.id}`,
      syncedSource: null,
    };
  });
}

function parseSessionMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Hex/dash input that could be the start of a session id ("7d111fea"). */
const SHORT_ID_SHAPE = /^[0-9a-f][0-9a-f-]{3,35}$/i;

/**
 * Conversations by what their inbox row shows: the captured name/phone/email/
 * address, the linked request number, the words of the first customer message
 * (the "Web chat · “my AC is…”" title) and the short id. Later messages are
 * left to the inbox's own search to keep ⌘K fast.
 */
export async function searchConversations(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const pattern = containsPattern(q);
  const firstCustomerMessage = sql<string | null>`(
    SELECT ${messages.content} FROM ${messages}
    WHERE ${messages.sessionId} = ${customerSessions.id}
      AND ${messages.organizationId} = ${customerSessions.organizationId}
      AND ${messages.role} = 'user'
    ORDER BY ${messages.createdAt} ASC
    LIMIT 1
  )`;
  const idMatch = SHORT_ID_SHAPE.test(q)
    ? sql`OR ${customerSessions.id}::text ILIKE ${`${q.toLowerCase()}%`}`
    : sql``;
  const rows = await db
    .select({
      id: customerSessions.id,
      channel: customerSessions.channel,
      status: customerSessions.status,
      metadata: customerSessions.metadata,
      handledAt: customerSessions.handledAt,
    })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        notStandInSession(customerSessions.token),
        sql`(
            ${sessionContactMatches(customerSessions.metadata, pattern)}
            OR EXISTS (
              SELECT 1 FROM ${serviceRequests}
              WHERE ${serviceRequests.sessionId} = ${customerSessions.id}
                AND ${serviceRequests.organizationId} = ${customerSessions.organizationId}
                AND ${serviceRequests.referenceNumber} ILIKE ${pattern}
            )
            OR ${firstCustomerMessage} ILIKE ${pattern}
            ${idMatch}
          )`,
      ),
    )
    .orderBy(desc(customerSessions.createdAt))
    .limit(RESULTS_PER_TYPE);

  if (rows.length === 0) return [];

  // Only in WHERE: drizzle leaves a single-table select list unqualified, so
  // a messages subquery there would compare against messages.id. The preview
  // and the needs-action inputs come from these two keyed reads instead.
  const sessionIds = rows.map((row) => row.id);
  const [customerMessageRows, requestRows] = await Promise.all([
    db
      .select({
        sessionId: messages.sessionId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        withTenant(
          messages,
          organizationId,
          inArray(messages.sessionId, sessionIds),
          eq(messages.role, "user"),
        ),
      )
      .orderBy(asc(messages.createdAt)),
    // The linked request's customer names the chat when the bot captured none.
    db
      .select({
        sessionId: serviceRequests.sessionId,
        referenceNumber: serviceRequests.referenceNumber,
        requestNameEncrypted: serviceRequests.customerNameEncrypted,
        customerNameEncrypted: customers.nameEncrypted,
      })
      .from(serviceRequests)
      .leftJoin(
        customers,
        and(
          eq(customers.id, serviceRequests.customerId),
          eq(customers.organizationId, organizationId),
        ),
      )
      .where(
        withTenant(serviceRequests, organizationId, inArray(serviceRequests.sessionId, sessionIds)),
      )
      .orderBy(asc(serviceRequests.createdAt)),
  ]);
  const firstMessage = new Map<string, string>();
  const lastMessageAt = new Map<string, string>();
  for (const m of customerMessageRows) {
    if (!firstMessage.has(m.sessionId)) firstMessage.set(m.sessionId, m.content);
    lastMessageAt.set(m.sessionId, m.createdAt.toISOString());
  }
  const requestBySession = new Map<string, { reference: string; name: string | null }>();
  for (const r of requestRows) {
    if (requestBySession.has(r.sessionId)) continue;
    requestBySession.set(r.sessionId, {
      reference: r.referenceNumber,
      name: displayableName(r.requestNameEncrypted, r.customerNameEncrypted),
    });
  }

  return rows.map((row) => {
    const customerName = customerNameFromMetadata(parseSessionMetadata(row.metadata));
    const request = requestBySession.get(row.id);
    const requestCustomerName = request?.name ?? null;
    const title = conversationTitle({
      customerName,
      requestCustomerName,
      referenceNumber: request?.reference ?? null,
      id: row.id,
      channel: row.channel,
      preview: firstMessage.get(row.id) ?? null,
    });
    const flagged = needsAction({
      status: row.status,
      handledAt: row.handledAt ? row.handledAt.toISOString() : null,
      lastCustomerMessageAt: lastMessageAt.get(row.id) ?? null,
    });
    const named = customerName !== null || requestCustomerName !== null;
    const subtitle = [
      named ? channelTitle(row.channel) : null,
      // The inbox's wording for an escalation nobody has handled.
      flagged ? "Needs action" : humanizeCode(row.status),
      shortConversationId(row.id),
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    return {
      type: "conversation" as const,
      id: row.id,
      title,
      subtitle,
      href: `/admin/conversations?c=${row.id}`,
      syncedSource: null,
    };
  });
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  technician: "Technician",
};

/**
 * Staff by name (users.name is plaintext — only customer PII is encrypted).
 * Results open the Staff page, which has no per-person route.
 */
export async function searchStaff(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(withTenant(users, organizationId, ilike(users.name, containsPattern(q))))
    .orderBy(asc(users.name))
    .limit(RESULTS_PER_TYPE);

  return rows.map((row) => ({
    type: "staff" as const,
    id: row.id,
    title: row.name,
    subtitle: `${ROLE_LABELS[row.role] ?? "Staff"}${row.isActive ? "" : " · Inactive"}`,
    href: "/admin/staff",
    syncedSource: null,
  }));
}

export async function searchEstimates(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const term = q.toLowerCase();
  const rows = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      totalCents: estimates.totalCents,
      fieldpulseEstimateId: estimates.fieldpulseEstimateId,
      fieldpulseStatusName: estimates.fieldpulseStatusName,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId))
    .orderBy(desc(estimates.createdAt))
    .limit(SCAN_LIMIT_ESTIMATES);

  const results: SearchResult[] = [];
  for (const row of rows) {
    const estTitle = `EST-${row.id.slice(0, 8).toUpperCase()}`;
    const matches =
      row.id.toLowerCase().startsWith(term) ||
      (row.fieldpulseEstimateId?.toLowerCase().includes(term) ?? false);
    if (!matches) continue;
    results.push({
      type: "estimate",
      id: row.id,
      title: estTitle,
      subtitle: row.fieldpulseStatusName ?? row.status,
      href: `/admin/estimates/${row.id}`,
      syncedSource: row.fieldpulseEstimateId ? "fieldpulse" : null,
    });
    if (results.length >= RESULTS_PER_TYPE) break;
  }
  return results;
}

/**
 * Runs 4 org-scoped entity searches in parallel and returns all results.
 * Callers must ensure q.length >= 2 before calling this function.
 */
/**
 * Pricebook items by name or SKU. Both are plaintext, so we ILIKE in SQL (no
 * decrypt-scan) and cap at RESULTS_PER_TYPE. Active items only. Results deep-link
 * to the pricebook list filtered to the item's name (leveraging URL-persist), as
 * the pricebook has no per-item detail route.
 */
export async function searchPricebook(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const like = `%${q}%`;
  const rows = await db
    .select({
      id: pricebookItems.id,
      name: pricebookItems.name,
      sku: pricebookItems.sku,
      priceCents: pricebookItems.priceCents,
      type: pricebookItems.type,
      fieldpulseItemId: pricebookItems.fieldpulseItemId,
    })
    .from(pricebookItems)
    .where(
      and(
        withTenant(pricebookItems, organizationId),
        eq(pricebookItems.active, true),
        or(ilike(pricebookItems.name, like), ilike(pricebookItems.sku, like)),
      ),
    )
    .orderBy(desc(pricebookItems.createdAt))
    .limit(RESULTS_PER_TYPE);

  return rows.map((row) => ({
    type: "pricebook" as const,
    id: row.id,
    title: row.name,
    subtitle: `${humanizeCode(row.type)} · ${formatCents(row.priceCents)}${row.sku ? ` · ${row.sku}` : ""}`,
    href: `/admin/pricebook?q=${encodeURIComponent(row.name)}`,
    syncedSource: row.fieldpulseItemId ? "fieldpulse" : null,
  }));
}

export async function searchAllEntities(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const [
    customerResults,
    invoiceResults,
    jobResults,
    conversationResults,
    estimateResults,
    pricebookResults,
    staffResults,
  ] = await Promise.all([
    searchCustomers(organizationId, q),
    searchInvoices(organizationId, q),
    searchJobs(organizationId, q),
    searchConversations(organizationId, q),
    searchEstimates(organizationId, q),
    searchPricebook(organizationId, q),
    searchStaff(organizationId, q),
  ]);

  return [
    ...customerResults,
    ...invoiceResults,
    ...jobResults,
    ...conversationResults,
    ...estimateResults,
    ...pricebookResults,
    ...staffResults,
  ];
}
