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
import { eq, sql, count, desc, asc, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  serviceRequests,
  serviceHistory,
  auditLog,
  sessionStatusEnum,
  sessionChannelEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  ConversationSummary,
  ConversationMessage,
  ConversationDetail,
  ConversationFilters,
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

export async function getConversations(
  organizationId: string,
  filters: ConversationFilters,
): Promise<{
  readonly conversations: readonly ConversationSummary[];
  readonly total: number;
}> {
  const page = Math.max(1, filters.page ?? DEFAULT_PAGE);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, filters.limit ?? DEFAULT_LIMIT),
  );
  const offset = (page - 1) * limit;

  // Build the set of tenant-scoped conditions for the session listing.
  const conditions: SQL[] = [];
  if (filters.status && isValidStatus(filters.status)) {
    conditions.push(eq(customerSessions.status, filters.status));
  }
  if (filters.channel && isValidChannel(filters.channel)) {
    conditions.push(eq(customerSessions.channel, filters.channel));
  }

  // Optional search: restrict to sessions whose id text-matches OR that have at
  // least one message whose content matches (case-insensitive substring).
  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      sql`(
        ${customerSessions.id}::text ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.sessionId} = ${customerSessions.id}
            AND ${messages.organizationId} = ${customerSessions.organizationId}
            AND ${messages.content} ILIKE ${pattern}
        )
      )`,
    );
  }

  const whereClause = withTenant(
    customerSessions,
    organizationId,
    ...conditions,
  );

  // Total count of matching sessions.
  const [countResult] = await db
    .select({ value: count() })
    .from(customerSessions)
    .where(whereClause);

  const total = countResult?.value ?? 0;

  // Page of sessions ordered by recency.
  const sessionRows = await db
    .select({
      id: customerSessions.id,
      status: customerSessions.status,
      channel: customerSessions.channel,
      turnCount: customerSessions.turnCount,
      tokensUsed: customerSessions.tokensUsed,
      createdAt: customerSessions.createdAt,
      updatedAt: customerSessions.updatedAt,
    })
    .from(customerSessions)
    .where(whereClause)
    .orderBy(desc(customerSessions.createdAt))
    .limit(limit)
    .offset(offset);

  if (sessionRows.length === 0) {
    return { conversations: [], total };
  }

  const sessionIds = sessionRows.map((row) => row.id);

  // Aggregate per-session message stats in a single grouped query.
  const aggregateRows = await db
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
    .groupBy(messages.sessionId);

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

  // First user message per session for the preview. Fetch ordered ascending and
  // keep the earliest user message encountered per session.
  const userMessageRows = await db
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
    .orderBy(asc(messages.createdAt));

  const previewBySession = new Map<string, string | null>();
  for (const row of userMessageRows) {
    if (!previewBySession.has(row.sessionId)) {
      previewBySession.set(row.sessionId, buildPreview(row.content));
    }
  }

  // Service request lookup (optional) per session.
  const requestRows = await db
    .select({
      sessionId: serviceRequests.sessionId,
      referenceNumber: serviceRequests.referenceNumber,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        inArray(serviceRequests.sessionId, sessionIds),
      ),
    );

  const referenceBySession = new Map<string, string>();
  for (const row of requestRows) {
    if (!referenceBySession.has(row.sessionId)) {
      referenceBySession.set(row.sessionId, row.referenceNumber);
    }
  }

  const conversations: readonly ConversationSummary[] = sessionRows.map(
    (row) => {
      const aggregate = aggregateBySession.get(row.id);
      const referenceNumber = referenceBySession.get(row.id) ?? null;
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
      };
    },
  );

  return { conversations, total };
}

export async function getConversationById(
  organizationId: string,
  sessionId: string,
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
      createdAt: customerSessions.createdAt,
      updatedAt: customerSessions.updatedAt,
    })
    .from(customerSessions)
    .where(
      withTenant(
        customerSessions,
        organizationId,
        eq(customerSessions.id, sessionId),
      ),
    );

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

  // Optional service request lookup for reference number + presence flag.
  const [requestRow] = await db
    .select({ referenceNumber: serviceRequests.referenceNumber })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.sessionId, sessionId),
      ),
    )
    .limit(1);

  const referenceNumber = requestRow?.referenceNumber ?? null;

  return {
    id: sessionRow.id,
    status: sessionRow.status,
    channel: sessionRow.channel,
    turnCount: sessionRow.turnCount,
    tokensUsed: sessionRow.tokensUsed,
    tokenBudget: sessionRow.tokenBudget,
    metadata: parseMetadata(sessionRow.metadata),
    runningSummary: sessionRow.runningSummary ?? null,
    referenceNumber,
    hasServiceRequest: referenceNumber !== null,
    createdAt: sessionRow.createdAt.toISOString(),
    updatedAt: sessionRow.updatedAt.toISOString(),
    messages: conversationMessages,
  };
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
 *   3. audit_log        (references customer_sessions.id, nullable)
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
    // 1b. service_requests for this session.
    db
      .delete(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.sessionId, sessionId),
        ),
      ),
    // 2. audit_log rows referencing this session (sessionId is nullable).
    db
      .delete(auditLog)
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
