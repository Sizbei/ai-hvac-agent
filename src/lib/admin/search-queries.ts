import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customers,
  serviceRequests,
  estimates,
  invoices,
  pricebookItems,
  customerSessions,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { invoiceRef } from "@/lib/admin/invoice-collectible";
import { issueTypeLabel, humanizeCode } from "@/lib/admin/request-labels";
import { notStandInSession } from "@/lib/admin/stand-in-session";
import { customerNameFromMetadata } from "@/lib/admin/conversation-display";

export type SearchResult = {
  readonly type: "customer" | "invoice" | "job" | "conversation" | "estimate" | "pricebook";
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
  return `$${(cents / 100).toFixed(2)}`;
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
      subtitle: `${row.state} · ${formatCents(row.totalCents)}`,
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
    })
    .from(serviceRequests)
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

  return rows.map((row) => ({
    type: "job" as const,
    id: row.id,
    title: row.referenceNumber ?? `Request ${row.id.slice(0, 8).toUpperCase()}`,
    subtitle: issueTypeLabel(row.issueType),
    // There is no /admin/requests/[id] page; the list opens the sheet.
    href: `/admin/requests?request=${row.id}`,
    syncedSource: null,
  }));
}

const CHANNEL_NAMES: Record<string, string> = {
  phone: "Phone call",
  sms: "Text message",
  web: "Web chat",
};

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

/**
 * Conversations by the intake's captured name/phone/email (session metadata,
 * not encrypted) or the linked request number. Message text is left to the
 * inbox's own search to keep ⌘K fast.
 */
export async function searchConversations(
  organizationId: string,
  q: string,
): Promise<SearchResult[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db
    .select({
      id: customerSessions.id,
      channel: customerSessions.channel,
      status: customerSessions.status,
      metadata: customerSessions.metadata,
    })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        notStandInSession(customerSessions.token),
        sql`(
            coalesce(${customerSessions.metadata}, '') ILIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM ${serviceRequests}
              WHERE ${serviceRequests.sessionId} = ${customerSessions.id}
                AND ${serviceRequests.organizationId} = ${customerSessions.organizationId}
                AND ${serviceRequests.referenceNumber} ILIKE ${pattern}
            )
          )`,
      ),
    )
    .orderBy(desc(customerSessions.createdAt))
    .limit(RESULTS_PER_TYPE);

  return rows.map((row) => ({
    type: "conversation" as const,
    id: row.id,
    title:
      customerNameFromMetadata(parseSessionMetadata(row.metadata)) ??
      `Conversation ${row.id.slice(0, 8)}`,
    subtitle: `${CHANNEL_NAMES[row.channel] ?? "Conversation"} · ${humanizeCode(row.status)}`,
    href: `/admin/conversations?c=${row.id}`,
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
    subtitle: `${row.type} · ${formatCents(row.priceCents)}${row.sku ? ` · ${row.sku}` : ""}`,
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
  ] = await Promise.all([
    searchCustomers(organizationId, q),
    searchInvoices(organizationId, q),
    searchJobs(organizationId, q),
    searchConversations(organizationId, q),
    searchEstimates(organizationId, q),
    searchPricebook(organizationId, q),
  ]);

  return [
    ...customerResults,
    ...invoiceResults,
    ...jobResults,
    ...conversationResults,
    ...estimateResults,
    ...pricebookResults,
  ];
}
