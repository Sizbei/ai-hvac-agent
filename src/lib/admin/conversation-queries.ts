/**
 * Database query functions for admin "saved conversations" feature.
 *
 * Conversations live in `customer_sessions` + `messages`. A session may never
 * become a `service_request` (e.g. when AI extraction fails), so these queries
 * read conversations directly from sessions/messages and treat the service
 * request as an optional left-join lookup.
 *
 * Every query is tenant-scoped via withTenant (multi-tenancy contract).
 *
 * NOTE: messages/sessions are NOT encrypted (unlike serviceRequests PII) — do
 * not attempt to decrypt message content here.
 */
import { and, eq, sql, count, desc, asc, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  customers,
  messages,
  serviceRequests,
  serviceHistory,
  entityTags,
  auditLog,
  sessionStatusEnum,
  sessionChannelEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { visibleRows, visibleRowsSql, type Visibility } from "./visibility";
import { decrypt } from "@/lib/crypto";
import { ERASED_PLACEHOLDER } from "./report-format";
import { notStandInSession } from "./stand-in-session";
import { sessionContactMatches, sessionPhoneDigitsMatch } from "./session-contact-search";
import {
  customerNameFromMetadata,
  needsAction,
  phoneDigitsQuery,
} from "./conversation-display";
import type {
  ConversationSummary,
  ConversationMessage,
  ConversationDetail,
  ConversationFilters,
  ConversationListResult,
} from "./conversation-types";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PREVIEW_MAX_LENGTH = 120;

type SessionStatus = (typeof sessionStatusEnum.enumValues)[number];

function isValidStatus(value: string): value is SessionStatus {
  return (sessionStatusEnum.enumValues as readonly string[]).includes(value);
}

type SessionChannel = (typeof sessionChannelEnum.enumValues)[number];

function isValidChannel(value: string): value is SessionChannel {
  return (sessionChannelEnum.enumValues as readonly string[]).includes(value);
}

/**
 * Trim a message body to the preview length, appending an ellipsis when
 * truncation actually occurs.
 */
function buildPreview(content: string | null | undefined): string | null {
  if (!content) {
    return null;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= PREVIEW_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, PREVIEW_MAX_LENGTH)}…`;
}

/**
 * Safely parse the session metadata TEXT column (JSON) into an object.
 * Returns null when absent or unparseable (or not an object).
 */
/**
 * Normalize a timestamp value returned by the driver (which may be a Date or an
 * ISO/SQL string depending on the column/aggregate) into an ISO string. Returns
 * null for absent or invalid values.
 */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The linked request's customer name (the request's own copy, else the
 * customer row's — FieldPulse imports only have the latter). Null when neither
 * decrypts or the customer was erased.
 */
function requestCustomerName(
  requestNameEncrypted: string | null,
  customerNameEncrypted: string | null,
): string | null {
  for (const encrypted of [requestNameEncrypted, customerNameEncrypted]) {
    if (!encrypted) continue;
    try {
      const name = decrypt(encrypted).trim();
      if (name.length > 0 && name !== ERASED_PLACEHOLDER) return name;
    } catch {
      // Undecryptable (rotated key / bad row): try the next copy.
    }
  }
  return null;
}

/** Org-scoped left join from a request to its customer row (names only). */
function requestCustomerJoin(organizationId: string): SQL | undefined {
  return and(
    eq(customers.id, serviceRequests.customerId),
    eq(customers.organizationId, organizationId),
  );
}

/**
 * Escalated and not handled since the customer last wrote. Mirrors the pure
 * `needsAction` helper in conversation-display.ts. Exported so ⌘K labels a
 * result "Needs action" by the inbox's own definition.
 */
export const needsActionSql = sql<boolean>`(
  ${customerSessions.status} = 'escalated'
  AND (
    ${customerSessions.handledAt} IS NULL
    OR EXISTS (
      SELECT 1 FROM ${messages}
      WHERE ${messages.sessionId} = ${customerSessions.id}
        AND ${messages.organizationId} = ${customerSessions.organizationId}
        AND ${messages.role} = 'user'
        AND ${messages.createdAt} > ${customerSessions.handledAt}
    )
  )
)`;

/**
 * The org-wide "Needs action" count the inbox shows on its filter button. Not
 * awaited, so callers can put it in their own db.batch. The dashboard (and the
 * nav badge) import THIS, never a copy of the SQL, so the numbers agree.
 */
export function buildNeedsActionCountQuery(organizationId: string, vis: Visibility) {
  return db
    .select({ value: count() })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        notStandInSession(customerSessions.token),
        needsActionSql,
        visibleRows(customerSessions, vis),
      ),
    );
}

/** Last message time, else the session's creation time — the inbox sort key. */
const lastActivitySql = sql<Date | string>`coalesce(
  (SELECT max(${messages.createdAt}) FROM ${messages}
    WHERE ${messages.sessionId} = ${customerSessions.id}
      AND ${messages.organizationId} = ${customerSessions.organizationId}),
  ${customerSessions.createdAt}
)`;

/**
 * Not an empty widget open: the customer said something, or the session has a
 * request (e.g. a phone call whose transcript wasn't stored).
 */
const hasContentSql = sql`(
  EXISTS (
    SELECT 1 FROM ${messages}
    WHERE ${messages.sessionId} = ${customerSessions.id}
      AND ${messages.organizationId} = ${customerSessions.organizationId}
      AND ${messages.role} = 'user'
  )
  OR EXISTS (
    SELECT 1 FROM ${serviceRequests}
    WHERE ${serviceRequests.sessionId} = ${customerSessions.id}
      AND ${serviceRequests.organizationId} = ${customerSessions.organizationId}
  )
)`;

export async function getConversations(
  organizationId: string,
  filters: ConversationFilters,
  vis: Visibility,
): Promise<ConversationListResult> {
  const page = Math.max(1, filters.page ?? DEFAULT_PAGE);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, filters.limit ?? DEFAULT_LIMIT),
  );
  const offset = (page - 1) * limit;

  // Build the set of tenant-scoped conditions for the session listing. Stand-in
  // sessions (office bookings, membership visits, FieldPulse import) have no
  // messages — they are not conversations.
  const conditions: SQL[] = [notStandInSession(customerSessions.token)];
  if (filters.status && isValidStatus(filters.status)) {
    conditions.push(eq(customerSessions.status, filters.status));
  }
  if (filters.channel && isValidChannel(filters.channel)) {
    conditions.push(eq(customerSessions.channel, filters.channel));
  }
  if (!filters.includeEmpty) {
    conditions.push(hasContentSql);
  }
  if (filters.needsAction) {
    conditions.push(needsActionSql);
  }

  // Optional search: restrict to sessions whose id text-matches OR that have at
  // least one message whose content matches (case-insensitive substring).
  const search = filters.search?.trim();
  if (search) {
    // Escape LIKE metacharacters (% _ \) so a search of "%" or "_" matches them
    // literally instead of becoming a wildcard that full-scans messages.content.
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    // A phone-shaped search also matches the digits of the captured phone and
    // of an SMS thread's number, however the number was formatted.
    const digits = phoneDigitsQuery(search);
    const digitsMatch = digits
      ? sql`OR ${sessionPhoneDigitsMatch(customerSessions.metadata, customerSessions.token, digits)}`
      : sql``;
    conditions.push(
      sql`(
        ${customerSessions.id}::text ILIKE ${pattern}
        OR ${sessionContactMatches(customerSessions.metadata, pattern)}
        OR EXISTS (
          SELECT 1 FROM ${serviceRequests}
          WHERE ${serviceRequests.sessionId} = ${customerSessions.id}
            AND ${serviceRequests.organizationId} = ${customerSessions.organizationId}
            AND ${serviceRequests.referenceNumber} ILIKE ${pattern}
            AND ${visibleRowsSql("service_requests", vis)}
        )
        OR EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.sessionId} = ${customerSessions.id}
            AND ${messages.organizationId} = ${customerSessions.organizationId}
            AND ${messages.content} ILIKE ${pattern}
        )
        ${digitsMatch}
      )`,
    );
  }

  const whereClause = withTenant(
    customerSessions,
    organizationId,
    ...conditions,
  );

  // Stage 1: count, page and the org-wide needs-action count run concurrently
  // in one round trip (neither depends on the other). A hidden session is out
  // of all three, so the badge and the "Needs action" list agree.
  const [[countResult], sessionRows, [needsActionResult]] = await db.batch([
    db
      .select({ value: count() })
      .from(customerSessions)
      .where(and(whereClause, visibleRows(customerSessions, vis))),
    db
      .select({
        id: customerSessions.id,
        status: customerSessions.status,
        channel: customerSessions.channel,
        turnCount: customerSessions.turnCount,
        tokensUsed: customerSessions.tokensUsed,
        metadata: customerSessions.metadata,
        // Not needsActionSql: drizzle leaves a single-table select list
        // unqualified, so its messages subquery would compare messages.id.
        // The flag is derived below from the same inputs instead.
        handledAt: customerSessions.handledAt,
        createdAt: customerSessions.createdAt,
        updatedAt: customerSessions.updatedAt,
      })
      .from(customerSessions)
      .where(and(whereClause, visibleRows(customerSessions, vis)))
      // Inbox order: most recent activity first, not session creation.
      .orderBy(desc(lastActivitySql), desc(customerSessions.id))
      .limit(limit)
      .offset(offset),
    buildNeedsActionCountQuery(organizationId, vis),
  ]);

  const total = countResult?.value ?? 0;
  const needsActionCount = needsActionResult?.value ?? 0;

  if (sessionRows.length === 0) {
    return { conversations: [], total, needsActionCount };
  }

  const sessionIds = sessionRows.map((row) => row.id);

  // Stage 2: aggregate stats, first-message previews, and service-request refs
  // are all keyed on sessionIds — run them in parallel. Messages are children
  // of the visible sessions above; a hidden request or customer adds no
  // reference number or name.
  const [aggregateRows, userMessageRows, requestRows] = await Promise.all([
    // Aggregate per-session message stats in a single grouped query.
    db
      .select({
        sessionId: messages.sessionId,
        messageCount: count(),
        lastMessageAt: sql<Date | string | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(
        withTenant(
          messages,
          organizationId,
          inArray(messages.sessionId, sessionIds),
        ),
      )
      .groupBy(messages.sessionId),

    // First user message per session for the preview. Fetch ordered ascending
    // and keep the earliest user message encountered per session.
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

    // Service request lookup (optional) per session.
    db
      .select({
        sessionId: serviceRequests.sessionId,
        referenceNumber: serviceRequests.referenceNumber,
        requestNameEncrypted: serviceRequests.customerNameEncrypted,
        customerNameEncrypted: customers.nameEncrypted,
      })
      .from(serviceRequests)
      .leftJoin(customers, and(requestCustomerJoin(organizationId), visibleRows(customers, vis)))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          inArray(serviceRequests.sessionId, sessionIds),
          visibleRows(serviceRequests, vis),
        ),
      ),
  ]);

  const aggregateBySession = new Map<
    string,
    { messageCount: number; lastMessageAt: Date | string | null }
  >();
  for (const row of aggregateRows) {
    aggregateBySession.set(row.sessionId, {
      messageCount: row.messageCount,
      lastMessageAt: row.lastMessageAt,
    });
  }

  const previewBySession = new Map<string, string | null>();
  const lastCustomerMessageAt = new Map<string, string>();
  for (const row of userMessageRows) {
    if (!previewBySession.has(row.sessionId)) {
      previewBySession.set(row.sessionId, buildPreview(row.content));
    }
    // Ascending order: the last write wins.
    lastCustomerMessageAt.set(row.sessionId, row.createdAt.toISOString());
  }

  const requestBySession = new Map<
    string,
    { referenceNumber: string; customerName: string | null }
  >();
  for (const row of requestRows) {
    if (!requestBySession.has(row.sessionId)) {
      requestBySession.set(row.sessionId, {
        referenceNumber: row.referenceNumber,
        customerName: requestCustomerName(row.requestNameEncrypted, row.customerNameEncrypted),
      });
    }
  }

  const conversations: readonly ConversationSummary[] = sessionRows.map(
    (row) => {
      const aggregate = aggregateBySession.get(row.id);
      const request = requestBySession.get(row.id);
      const referenceNumber = request?.referenceNumber ?? null;
      const lastMessageAt = aggregate?.lastMessageAt ?? null;
      return {
        id: row.id,
        status: row.status,
        channel: row.channel,
        turnCount: row.turnCount,
        messageCount: aggregate?.messageCount ?? 0,
        tokensUsed: row.tokensUsed,
        preview: previewBySession.get(row.id) ?? null,
        hasServiceRequest: referenceNumber !== null,
        referenceNumber,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastMessageAt: toIsoOrNull(lastMessageAt),
        customerName: customerNameFromMetadata(parseMetadata(row.metadata)),
        requestCustomerName: request?.customerName ?? null,
        needsAction: needsAction({
          status: row.status,
          handledAt: row.handledAt ? row.handledAt.toISOString() : null,
          lastCustomerMessageAt: lastCustomerMessageAt.get(row.id) ?? null,
        }),
      };
    },
  );

  return { conversations, total, needsActionCount };
}

export async function getConversationById(
  organizationId: string,
  sessionId: string,
  vis: Visibility,
): Promise<ConversationDetail | null> {
  const [sessionRow] = await db
    .select({
      id: customerSessions.id,
      status: customerSessions.status,
      channel: customerSessions.channel,
      turnCount: customerSessions.turnCount,
      tokensUsed: customerSessions.tokensUsed,
      tokenBudget: customerSessions.tokenBudget,
      metadata: customerSessions.metadata,
      runningSummary: customerSessions.runningSummary,
      summary: customerSessions.summary,
      outcome: customerSessions.outcome,
      nextSteps: customerSessions.nextSteps,
      mode: customerSessions.mode,
      handledAt: customerSessions.handledAt,
      createdAt: customerSessions.createdAt,
      updatedAt: customerSessions.updatedAt,
    })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        eq(customerSessions.id, sessionId),
        // A hidden session is "not found" for an org user (the detail GET 404s).
        visibleRows(customerSessions, vis),
      ),
    );

  // The transcript below is a child of this row: read only once it passed.
  if (!sessionRow) {
    return null;
  }

  const messageRows = await db
    .select({
      role: messages.role,
      content: messages.content,
      tokensUsed: messages.tokensUsed,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      withTenant(messages, organizationId, eq(messages.sessionId, sessionId)),
    )
    .orderBy(asc(messages.createdAt));

  const conversationMessages: readonly ConversationMessage[] = messageRows.map(
    (m) => ({
      role: m.role,
      content: m.content,
      tokensUsed: m.tokensUsed ?? null,
      createdAt: m.createdAt.toISOString(),
    }),
  );

  // Optional service request lookup (reference number + id for the link), and
  // the staff-reply audit rows that tell office replies apart from the AI's.
  const [[requestRow], replyAuditRows] = await db.batch([
    db
      .select({
        id: serviceRequests.id,
        referenceNumber: serviceRequests.referenceNumber,
        requestNameEncrypted: serviceRequests.customerNameEncrypted,
        customerNameEncrypted: customers.nameEncrypted,
      })
      .from(serviceRequests)
      .leftJoin(customers, and(requestCustomerJoin(organizationId), visibleRows(customers, vis)))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.sessionId, sessionId),
          visibleRows(serviceRequests, vis),
        ),
      )
      .limit(1),
    db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        withTenant(
          auditLog,
          organizationId,
          eq(auditLog.entity, "customer_sessions"),
          eq(auditLog.entityId, sessionId),
          eq(auditLog.action, "conversation_reply_sent"),
        ),
      ),
  ]);

  const referenceNumber = requestRow?.referenceNumber ?? null;
  const handledAt = sessionRow.handledAt ? sessionRow.handledAt.toISOString() : null;
  const lastCustomerMessage = [...conversationMessages].reverse().find((m) => m.role === "user");

  return {
    id: sessionRow.id,
    status: sessionRow.status,
    channel: sessionRow.channel,
    turnCount: sessionRow.turnCount,
    tokensUsed: sessionRow.tokensUsed,
    tokenBudget: sessionRow.tokenBudget,
    metadata: parseMetadata(sessionRow.metadata),
    runningSummary: sessionRow.runningSummary ?? null,
    summary: sessionRow.summary ?? null,
    outcome: sessionRow.outcome ?? null,
    nextSteps: sessionRow.nextSteps ?? null,
    mode: sessionRow.mode,
    referenceNumber,
    serviceRequestId: requestRow?.id ?? null,
    requestCustomerName: requestRow
      ? requestCustomerName(requestRow.requestNameEncrypted, requestRow.customerNameEncrypted)
      : null,
    hasServiceRequest: referenceNumber !== null,
    handledAt,
    needsAction: needsAction({
      status: sessionRow.status,
      handledAt,
      lastCustomerMessageAt: lastCustomerMessage?.createdAt ?? null,
    }),
    createdAt: sessionRow.createdAt.toISOString(),
    updatedAt: sessionRow.updatedAt.toISOString(),
    messages: conversationMessages,
    staffReplyTimes: replyAuditRows.map((r) => r.createdAt.toISOString()),
  };
}

/**
 * Mark an escalated conversation handled (clears "Needs action") or reopen it.
 * Tenant-scoped; only escalated sessions can be marked. Returns the new
 * handledAt (ISO or null), or `null` when no escalated session matched.
 * Writes an audit row with ids only (no PII).
 */
export async function setConversationHandled(
  organizationId: string,
  sessionId: string,
  handled: boolean,
  actor: { readonly userId: string; readonly ipAddress?: string | null },
): Promise<{ readonly handledAt: string | null } | null> {
  const handledAt = handled ? new Date() : null;
  const [updated] = await db
    .update(customerSessions)
    .set({ handledAt })
    .where(
      withTenant(
        customerSessions,
        organizationId,
        eq(customerSessions.id, sessionId),
        eq(customerSessions.status, "escalated"),
      ),
    )
    .returning({ id: customerSessions.id });

  if (!updated) {
    return null;
  }

  await db.insert(auditLog).values({
    organizationId,
    userId: actor.userId,
    actorType: "human",
    action: handled ? "conversation_marked_handled" : "conversation_reopened",
    entity: "customer_sessions",
    entityId: sessionId,
    ipAddress: actor.ipAddress ?? null,
  });

  return { handledAt: handledAt ? handledAt.toISOString() : null };
}

/**
 * Permanently delete a conversation (a `customer_sessions` row) and every record
 * that depends on it, all tenant-scoped to the given organization.
 *
 * Returns `false` when no matching session exists in the org (nothing deleted),
 * and `true` once the session and its dependents are removed.
 *
 * Deletion runs as a single atomic `db.batch` (the neon-http driver has no
 * interactive transactions) and follows FK dependency order, since none of the
 * dependent tables declare ON DELETE CASCADE:
 *   1. service_history (references service_requests.id)
 *   2. service_requests (references customer_sessions.id, NOT NULL)
 *   3. audit_log        (references customer_sessions.id, nullable) — NOT
 *      deleted. audit_log is an immutable record; instead its sessionId FK is
 *      nulled out (column is nullable) so the rows survive the conversation
 *      they describe, satisfying the FK before customer_sessions is dropped.
 *   4. messages         (references customer_sessions.id, NOT NULL)
 *   5. customer_sessions (the conversation itself)
 *
 * Finally a `conversation_deleted` audit-log row is written (with a null
 * sessionId, since the session no longer exists) recording who deleted it.
 */
export async function deleteConversation(
  organizationId: string,
  sessionId: string,
  actor?: { readonly userId?: string | null; readonly ipAddress?: string | null },
): Promise<boolean> {
  const [sessionRow] = await db
    .select({ id: customerSessions.id })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        eq(customerSessions.id, sessionId),
      ),
    )
    .limit(1);

  if (!sessionRow) {
    return false;
  }

  // The service_requests ids for this session, expressed as a subquery so the
  // service_history delete stays a single statement (no pre-read, no empty-array
  // edge case) and the whole cascade can run as one fixed-length atomic batch.
  const sessionRequestIds = db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.sessionId, sessionId),
      ),
    );

  // neon-http has no interactive transactions; db.batch runs these statements
  // in order as a single atomic transaction. Order respects FK dependencies.
  await db.batch([
    // 1a. service_history references service_requests.id — delete first.
    db
      .delete(serviceHistory)
      .where(
        withTenant(
          serviceHistory,
          organizationId,
          inArray(serviceHistory.serviceRequestId, sessionRequestIds),
        ),
      ),
    // 1b. Job tags are polymorphic (no FK) — clear them before the requests go.
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "job"), inArray(entityTags.entityId, sessionRequestIds))),
    // 1c. service_requests for this session.
    db
      .delete(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.sessionId, sessionId),
        ),
      ),
    // 2. audit_log rows referencing this session are preserved, not deleted —
    // the audit trail must outlive the conversation it describes. Null out the
    // (nullable) sessionId FK instead so the row still satisfies the
    // foreign key once customer_sessions is dropped below.
    db
      .update(auditLog)
      .set({ sessionId: null })
      .where(
        withTenant(auditLog, organizationId, eq(auditLog.sessionId, sessionId)),
      ),
    // 3. messages for this session.
    db
      .delete(messages)
      .where(
        withTenant(messages, organizationId, eq(messages.sessionId, sessionId)),
      ),
    // 4. The conversation (customer_sessions) row itself.
    db
      .delete(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          eq(customerSessions.id, sessionId),
        ),
      ),
    // 5. Record the deletion. sessionId is null (the session is gone); the
    // deleted session id is preserved in entityId, which has no FK.
    db.insert(auditLog).values({
      organizationId,
      userId: actor?.userId ?? null,
      sessionId: null,
      action: "conversation_deleted",
      entity: "customer_sessions",
      entityId: sessionId,
      ipAddress: actor?.ipAddress ?? null,
    }),
  ]);

  return true;
}
