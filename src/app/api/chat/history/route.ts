import { NextResponse } from 'next/server';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { customerSessions, messages } from '@/lib/db/schema';
import { getSessionToken } from '@/lib/session';
import { slidingWindow, RATE_LIMITS } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * GET /api/chat/history
 *
 * Fetches past conversation history for the current customer.
 * Returns sessions grouped by customerId, excluding the current active session.
 */
export async function GET() {
  try {
    const token = await getSessionToken();
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'No session found' },
        { status: 401 },
      );
    }

    // Rate limit per session (this read was previously unthrottled).
    const rate = slidingWindow(
      `chat:history:${token}`,
      RATE_LIMITS.sessionAction.maxRequests,
      RATE_LIMITS.sessionAction.windowMs,
    );
    if (!rate.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many requests' },
        { status: 429 },
      );
    }

    // Get current session
    const [currentSession] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!currentSession) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 },
      );
    }

    // If no customerId linked yet, return empty history
    if (!currentSession.customerId) {
      return NextResponse.json({
        success: true,
        sessions: [],
      });
    }

    const customerId = currentSession.customerId;
    const organizationId = currentSession.organizationId;

    // Past sessions for this customer, excluding the current one (org-scoped).
    const sessions = await db
      .select({
        id: customerSessions.id,
        status: customerSessions.status,
        createdAt: customerSessions.createdAt,
      })
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.customerId, customerId),
          eq(customerSessions.organizationId, organizationId),
          sql`${customerSessions.id} != ${currentSession.id}`,
        ),
      )
      .orderBy(desc(customerSessions.createdAt))
      .limit(10);

    // Fetch the recent messages for ALL these sessions in ONE query (no N+1),
    // then group in memory.
    const sessionIds = sessions.map((s) => s.id);
    const allMessages = sessionIds.length
      ? await db
          .select({
            sessionId: messages.sessionId,
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(inArray(messages.sessionId, sessionIds))
          .orderBy(desc(messages.createdAt))
      : [];

    const bySession = new Map<string, { content: string | null }[]>();
    for (const m of allMessages) {
      const list = bySession.get(m.sessionId) ?? [];
      list.push({ content: m.content });
      bySession.set(m.sessionId, list);
    }

    const sessionsWithPreview = sessions.map((session) => {
      const sessionMessages = bySession.get(session.id) ?? [];
      const firstUserMessage = sessionMessages.find(
        (m) => m.content && !m.content.startsWith('System:'),
      );
      return {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        preview: firstUserMessage?.content?.slice(0, 60) ?? 'New conversation',
        messageCount: sessionMessages.length,
      };
    });

    logger.info(
      { customerId, sessionCount: sessionsWithPreview.length },
      'Chat history fetched',
    );

    return NextResponse.json({
      success: true,
      sessions: sessionsWithPreview,
    });
  } catch (error) {
    logger.error({ error }, 'History endpoint error');
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
