import { NextRequest, NextResponse } from 'next/server';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { customerSessions, messages, customers } from '@/lib/db/schema';
import { getSessionToken } from '@/lib/session';
import { logger } from '@/lib/logger';

/**
 * GET /api/chat/history
 *
 * Fetches past conversation history for the current customer.
 * Returns sessions grouped by customerId, excluding the current active session.
 */
export async function GET(request: NextRequest) {
  try {
    const token = await getSessionToken();
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'No session found' },
        { status: 401 },
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

    // Fetch past sessions for this customer (excluding current session)
    const pastSessions = await db
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
          // Exclude current session
          eq(customerSessions.id, currentSession.id), // This will never match, need to use not()
        ),
      )
      .orderBy(desc(customerSessions.createdAt))
      .limit(10);

    // Exclude current session from history
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

    // For each session, get a preview and message count
    const sessionsWithPreview = await Promise.all(
      sessions.map(async (session) => {
        const sessionMessages = await db
          .select({ content: messages.content })
          .from(messages)
          .where(eq(messages.sessionId, session.id))
          .orderBy(desc(messages.createdAt))
          .limit(10);

        const firstUserMessage = sessionMessages.find((m) =>
          m.content && !m.content.startsWith('System:')
        );

        return {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          preview: firstUserMessage?.content?.slice(0, 60) ?? 'New conversation',
          messageCount: sessionMessages.length,
        };
      }),
    );

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
