import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// db.select() is called up to 3 times per request (current session, past
// sessions, past messages). Each call gets a thenable chain proxy that
// resolves to the next queued rows, regardless of which builder methods
// (.from/.where/.orderBy/.limit) are chained onto it.
const { selectQueue } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  return { selectQueue };
});

function chain(resolved: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(resolved);
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
  },
}));

vi.mock('@/lib/session', () => ({ getSessionToken: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { sessionAction: { maxRequests: 10, windowMs: 60_000 } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { GET } from './route';
import { getSessionToken } from '@/lib/session';
import { slidingWindow } from '@/lib/rate-limit';

const TOKEN = 'session-token';
const ORG = '00000000-0000-0000-0000-000000000001';
const CUSTOMER = '00000000-0000-0000-0000-000000000002';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';

function seedCurrentSession(overrides: Record<string, unknown> = {}): void {
  selectQueue.push([
    {
      id: SESSION_ID,
      token: TOKEN,
      organizationId: ORG,
      customerId: CUSTOMER,
      metadata: null,
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  selectQueue.length = 0;
  vi.clearAllMocks();
  (getSessionToken as unknown as Mock).mockResolvedValue(TOKEN);
  (slidingWindow as unknown as Mock).mockReturnValue({ allowed: true });
});

describe('GET /api/chat/history', () => {
  it('401 without a session token', async () => {
    (getSessionToken as unknown as Mock).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('429 when rate limited', async () => {
    (slidingWindow as unknown as Mock).mockReturnValue({ allowed: false });
    const res = await GET();
    expect(res.status).toBe(429);
  });

  it('404 when the session token does not resolve to a session', async () => {
    selectQueue.push([]); // current session lookup returns nothing
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('empty history for a session with no linked customer', async () => {
    seedCurrentSession({ customerId: null });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it('(A13) empty history for a linked session that has NOT passed verify', async () => {
    // Linked via an unverified contact-field match (metadata has no verify
    // key at all) — must NOT leak the linked customer's past sessions.
    seedCurrentSession({ metadata: null });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it('(A13) empty history for a linked session with a PENDING verify challenge', async () => {
    seedCurrentSession({
      metadata: JSON.stringify({ verify: { status: 'pending', attempts: 1 } }),
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it('(A13) empty history for a linked session with a FAILED verify (lockout)', async () => {
    seedCurrentSession({
      metadata: JSON.stringify({ verify: { status: 'failed', attempts: 2 } }),
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
  });

  it('returns past sessions once verify has PASSED', async () => {
    seedCurrentSession({
      metadata: JSON.stringify({ verify: { status: 'passed', attempts: 1 } }),
    });
    selectQueue.push([
      {
        id: 'past-session-1',
        status: 'completed',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    selectQueue.push([
      {
        sessionId: 'past-session-1',
        content: 'My AC is broken',
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('past-session-1');
    expect(body.sessions[0].preview).toBe('My AC is broken');
  });
});
