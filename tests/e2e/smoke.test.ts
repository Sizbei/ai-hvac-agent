import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// `server-only` throws at import in a non-server env; stub it so server modules
// (e.g. the tenancy resolver pulled in by the session route) can load in tests.
vi.mock('server-only', () => ({}));

// ─── Hoisted mocks ─────────────────────────────────────────────────

const {
  mockDbInsert,
  mockDbSelect,
  mockDbUpdate,
  mockDbDelete,
  mockSetSessionCookie,
  mockGetSessionToken,
  mockGenerateSessionToken,
  mockGetAdminSession,
  mockGetRequests,
  mockAssignTechnician,
  mockLogAudit,
  mockEncrypt,
  mockStreamText,
  mockExtractServiceRequest,
  mockGetDashboardStats,
  mockGetTechnicians,
} = vi.hoisted(() => {
  // Proxy-based chainable mock for Drizzle ORM query builder chain
  const createChainableMock = (terminal: ReturnType<typeof vi.fn>) => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') return undefined; // Not a promise
        if (
          prop === 'returning' ||
          prop === 'where' ||
          prop === 'orderBy'
        ) {
          return terminal;
        }
        return new Proxy(() => {}, handler) as unknown;
      },
      apply(_target, _thisArg, args) {
        return new Proxy(() => {}, handler) as unknown;
      },
    };
    return new Proxy(() => {}, handler) as unknown;
  };

  const mockDbInsert = vi.fn();
  const mockDbSelect = vi.fn();
  const mockDbUpdate = vi.fn();
  const mockDbDelete = vi.fn();

  return {
    mockDbInsert,
    mockDbSelect,
    mockDbUpdate,
    mockDbDelete,
    mockSetSessionCookie: vi.fn().mockResolvedValue(undefined),
    mockGetSessionToken: vi.fn(),
    mockGenerateSessionToken: vi.fn().mockReturnValue('mock-session-token-123'),
    mockGetAdminSession: vi.fn(),
    mockGetRequests: vi.fn(),
    mockAssignTechnician: vi.fn(),
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockEncrypt: vi.fn().mockImplementation((v: string) => `encrypted:${v}`),
    mockStreamText: vi.fn(),
    mockExtractServiceRequest: vi.fn(),
    mockGetDashboardStats: vi.fn(),
    mockGetTechnicians: vi.fn(),
    createChainableMock,
  };
});

// ─── Module mocks ──────────────────────────────────────────────────

// Keep the real NextRequest/NextResponse but stub `after()` to a no-op: the
// chat route schedules background extraction via after(), which throws outside
// Next's request scope when the handler is invoked directly in a unit test.
vi.mock('next/server', async (importActual) => {
  const actual = await importActual<typeof import('next/server')>();
  return { ...actual, after: vi.fn() };
});

vi.mock('@/lib/db', () => {
  // Create chainable thenable proxy. Every method call returns a new proxy.
  // The proxy is awaitable: `await db.select().from().where()` resolves via the mock fn.
  // This handles chains of any length: .where().orderBy(), .values().returning(), etc.
  function createProxy(terminalFn: () => unknown): unknown {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          // Make the proxy thenable — `await` resolves by calling the terminal fn
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            try {
              const result = terminalFn();
              Promise.resolve(result).then(resolve, reject);
            } catch (e) {
              reject(e);
            }
          };
        }
        // Any property access returns a callable proxy (for chaining)
        return new Proxy(() => {}, handler) as unknown;
      },
      apply() {
        // Any function call returns a new chainable proxy
        return new Proxy(() => {}, handler) as unknown;
      },
    };
    return new Proxy(() => {}, handler);
  }

  return {
    db: {
      insert: () => createProxy(mockDbInsert),
      select: () => createProxy(mockDbSelect),
      update: () => createProxy(mockDbUpdate),
      delete: () => createProxy(mockDbDelete),
      // neon-http runs db.batch() as a single atomic transaction; each element
      // is a thenable query proxy, so awaiting them all mirrors the real result
      // array (one entry per statement, in order).
      batch: (queries: readonly unknown[]) => Promise.all(queries),
    },
  };
});

// The confirm route resolves (and atomically creates) the CRM customer via
// upsertCustomerByContact before its batch. It's stubbed to return a fixed id
// so the confirm flow test stays focused on the request-submission path.
vi.mock('@/lib/admin/crm-queries', () => ({
  upsertCustomerByContact: vi.fn().mockResolvedValue('mock-customer-id'),
}));

vi.mock('@/lib/db/schema', () => ({
  customerSessions: { id: 'customer_sessions.id', token: 'token', status: 'status', organizationId: 'org_id', updatedAt: 'updated_at', createdAt: 'created_at' },
  messages: { sessionId: 'session_id', organizationId: 'org_id', createdAt: 'created_at' },
  serviceRequests: { id: 'service_requests.id' },
  auditLog: {},
  users: { email: 'users.email' },
  customers: { id: 'customers.id' },
  organizationSettings: {
    organizationId: 'org_settings.org_id',
    chatTokenBudget: 'org_settings.chat_token_budget',
    chatMaxTurns: 'org_settings.chat_max_turns',
  },
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: vi.fn((_table: unknown, _orgId: string, ...conditions: unknown[]) => conditions[0] ?? true),
}));

// Stage 5: the chat route now imports the open-availability query layer to offer
// real windows on the preferred-window step. Stub it so this smoke test (which
// mocks the schema minimally) doesn't pull the scheduling-source → schema chain.
// getOpenAvailability returns no windows → the chat route falls back to the
// static window prompt, which is all this smoke flow exercises.
vi.mock('@/lib/admin/availability-queries', () => ({
  getOpenAvailability: vi.fn().mockResolvedValue({ days: [], windows: [] }),
  businessDaysFrom: (start: string, count: number) =>
    Array.from({ length: count }, (_v, i) => `${start}+${i}`),
  businessTodayIso: () => '2026-07-01',
  AVAILABILITY_TIME_ZONE: 'America/New_York',
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
  inArray: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@/lib/session', () => ({
  generateSessionToken: () => mockGenerateSessionToken(),
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
  getSessionToken: () => mockGetSessionToken(),
  clearSessionCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: vi.fn().mockReturnValue({ allowed: true, remaining: 10, resetMs: 60000 }),
  RATE_LIMITS: {
    chat: { maxRequests: 20, windowMs: 60000 },
    sessionCreate: { maxRequests: 5, windowMs: 60000 },
    sessionAction: { maxRequests: 10, windowMs: 60000 },
    adminMutation: { maxRequests: 30, windowMs: 60000 },
  },
  resetRateLimitStore: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
  createAdminSession: vi.fn().mockResolvedValue(undefined),
  deleteAdminSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/admin/queries', () => ({
  getRequests: (...args: unknown[]) => mockGetRequests(...args),
  assignTechnician: (...args: unknown[]) => mockAssignTechnician(...args),
  getDashboardStats: (...args: unknown[]) => mockGetDashboardStats(...args),
  getTechnicians: (...args: unknown[]) => mockGetTechnicians(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (v: string) => mockEncrypt(v),
  decrypt: vi.fn((v: string) => v.replace('encrypted:', '')),
  encryptFields: vi.fn((data: Record<string, unknown>) => data),
  decryptFields: vi.fn((data: Record<string, unknown>) => data),
}));

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn().mockReturnValue('mock-model'),
  createOpenAI: vi.fn().mockReturnValue(vi.fn().mockReturnValue('mock-model')),
}));

// Bypass the real provider so it never calls createOpenAI at import time.
vi.mock('@/lib/ai/provider', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
  getExtractionModel: vi.fn().mockReturnValue('mock-model'),
}));

// This smoke test exercises the LLM streaming path; force the deterministic
// router to defer so streamText is reached (router has its own unit tests).
vi.mock('@/lib/ai/intent-router', () => ({
  routeMessage: vi.fn().mockReturnValue({
    action: 'FALLBACK_LLM',
    intentId: null,
    confidence: 0,
    reply: null,
    issueType: null,
    urgency: null,
    escalate: false,
  }),
}));

// The chat route loads the org's router config (disabled services, business
// info, custom FAQs) before routing. Stub it so the smoke flow doesn't hit the
// DB for config; the empty overlay leaves routing unchanged.
vi.mock('@/lib/admin/org-config-queries', () => ({
  getRouterConfig: vi.fn().mockResolvedValue({
    disabledIssueTypes: [],
    disabledServiceTags: [],
    businessInfo: {},
    customFaqs: [],
  }),
}));

vi.mock('@/lib/ai/system-prompt', () => ({
  SYSTEM_PROMPT: 'You are an HVAC assistant.',
  EXTRACTION_INSTRUCTION: 'Extract service request details.',
  // The chat route now brands the LLM persona via buildSystemPrompt(brandInfo);
  // stub it to a fixed persona so the smoke flow doesn't depend on branding.
  buildSystemPrompt: vi.fn(() => 'You are an HVAC assistant.'),
}));

vi.mock('@/lib/ai/guardrails', () => ({
  sanitizeInput: vi.fn((input: string) => ({
    safe: true,
    sanitized: input.trim(),
    flagged: [],
  })),
  validateExtractionOutput: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/extract', () => ({
  extractServiceRequest: (...args: unknown[]) => mockExtractServiceRequest(...args),
}));

vi.mock('@/lib/ai/state-machine', () => ({
  determineNextState: vi.fn().mockReturnValue('chatting'),
  isTerminalState: vi.fn().mockReturnValue(false),
  transition: vi.fn().mockReturnValue({ success: true, newState: 'confirmed' }),
  canTransition: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/token-budget', () => ({
  DEFAULT_TOKEN_BUDGET: 10_000,
  checkTokenBudget: vi.fn().mockReturnValue({ exhausted: false, remaining: 8000, warningThreshold: false }),
  addTokenUsage: vi.fn().mockReturnValue({ newTotal: 200, exceeded: false }),
}));

vi.mock('@/lib/ai/extraction-schema', () => ({
  isExtractionComplete: vi.fn().mockReturnValue(true),
  jobTypeForIssue: vi.fn().mockReturnValue('no_cool'),
  serviceRequestSchema: {
    safeParse: vi.fn().mockReturnValue({
      success: true,
      data: {
        issueType: 'cooling_not_working',
        urgency: 'high',
        description: 'AC not cooling properly',
        address: '123 Main St',
        customerName: 'Test User',
        customerPhone: '555-0100',
        customerEmail: null,
      },
    }),
  },
  extractionSchema: {},
  urgencyValues: ['low', 'medium', 'high', 'emergency'],
  issueTypeValues: ['heating_not_working', 'cooling_not_working', 'thermostat_issue', 'air_quality', 'strange_noises', 'water_leak', 'maintenance', 'installation', 'other'],
}));

vi.mock('@/lib/ai/metrics', () => ({
  trackAICall: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue('$2a$12$hashed'),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Route handler imports ─────────────────────────────────────────

import { POST as createSession, GET as getSession } from '@/app/api/session/route';
import { POST as sendChat } from '@/app/api/chat/route';
import { POST as confirmSession } from '@/app/api/session/confirm/route';
import { POST as escalateSession } from '@/app/api/session/escalate/route';
import { POST as adminLogin } from '@/app/api/auth/login/route';
import { GET as adminGetRequests } from '@/app/api/admin/requests/route';
import { POST as assignTechHandler } from '@/app/api/admin/requests/[id]/assign/route';
import { GET as adminGetStats } from '@/app/api/admin/stats/route';
import { GET as adminGetTechnicians } from '@/app/api/admin/technicians/route';
import { GET as cronCleanup } from '@/app/api/cron/cleanup/route';

// ─── Helpers ───────────────────────────────────────────────────────

function createMockRequest(options: {
  method?: string;
  body?: unknown;
  url?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}): NextRequest {
  const url = new URL(options.url ?? 'http://localhost:3000/api/session');
  const init: RequestInit & { headers: Record<string, string> } = {
    method: options.method ?? 'GET',
    headers: { ...options.headers },
  };
  // Default to a same-origin Origin header so the session-CSRF guard admits the
  // request, mirroring a real browser fetch from the app's own pages. A test
  // can still override `Origin` (e.g. to assert a cross-origin 403).
  if (init.headers['Origin'] === undefined) {
    init.headers['Origin'] = url.origin;
  }
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers['Content-Type'] = 'application/json';
  }
  return new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
}

// ─── Shared state across ordered test cases ────────────────────────

const MOCK_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const MOCK_REQUEST_ID = '660e8400-e29b-41d4-a716-446655440000';
const MOCK_TECH_ID = '770e8400-e29b-41d4-a716-446655440000';
const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

const mockAdminSession = {
  userId: 'admin-001',
  organizationId: DEMO_ORG_ID,
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

// ─── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('E2E Smoke Test: Full Customer-to-Admin Flow', () => {
  it('POST /api/session creates a new customer session', async () => {
    // The route reads the org's conversation-limit settings before inserting;
    // an empty row → resolvers fall back to the system defaults.
    mockDbSelect.mockResolvedValue([]);
    mockDbInsert.mockResolvedValue([
      {
        id: MOCK_SESSION_ID,
        organizationId: DEMO_ORG_ID,
        token: 'mock-session-token-123',
        status: 'chatting',
        tokensUsed: 0,
        tokenBudget: 10000,
        turnCount: 0,
        maxTurns: 15,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/session',
    });
    const response = await createSession(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('chatting');
    expect(body.data.sessionId).toBe(MOCK_SESSION_ID);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('mock-session-token-123');
  });

  it('POST /api/chat sends a message and gets AI streaming response', async () => {
    // Mock session lookup
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');
    mockDbSelect
      .mockResolvedValueOnce([
        {
          id: MOCK_SESSION_ID,
          organizationId: DEMO_ORG_ID,
          token: 'mock-session-token-123',
          status: 'chatting',
          tokensUsed: 0,
          tokenBudget: 10000,
          turnCount: 0,
          metadata: null,
        },
      ])
      // Message history (empty)
      .mockResolvedValueOnce([])
      // After-hours config lookup (no settings row → resolves to default/disabled)
      .mockResolvedValueOnce([]);

    // Mock streamText to return an object with toTextStreamResponse
    const mockResponse = new Response('AI response stream', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
    mockStreamText.mockReturnValue({
      toTextStreamResponse: () => mockResponse,
    });

    // Mock insert for user message (void return is fine)
    mockDbInsert.mockResolvedValue(undefined);

    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/chat',
      body: { message: 'My AC is broken and not cooling' },
    });
    const response = await sendChat(request);

    expect(response.status).toBe(200);
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'My AC is broken and not cooling' }),
        ]),
      }),
    );
  });

  it('POST /api/session/confirm submits a service request', async () => {
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');

    // Session lookup returns extracting session
    mockDbSelect.mockResolvedValueOnce([
      {
        id: MOCK_SESSION_ID,
        organizationId: DEMO_ORG_ID,
        token: 'mock-session-token-123',
        status: 'extracting',
        tokensUsed: 500,
        tokenBudget: 10000,
        turnCount: 3,
        metadata: JSON.stringify({
          issueType: 'cooling_not_working',
          urgency: 'high',
          address: '123 Main St',
        }),
      },
    ]);

    // The customer upsert now happens via the (mocked) upsertCustomerByContact
    // BEFORE the batch, so the batch inserts are: [0] service request insert
    // (returning), [1] audit log insert (void, falls through to default).
    mockDbInsert.mockResolvedValueOnce([
      {
        id: MOCK_REQUEST_ID,
        organizationId: DEMO_ORG_ID,
        sessionId: MOCK_SESSION_ID,
        status: 'pending',
        referenceNumber: 'HVAC-TEST1234',
      },
    ]);

    // Session status update (void)
    mockDbUpdate.mockResolvedValue(undefined);
    // Audit log insert (void)
    mockDbInsert.mockResolvedValue(undefined);

    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/session/confirm',
      body: {
        issueType: 'cooling_not_working',
        urgency: 'high',
        description: 'AC not cooling properly',
        address: '123 Main St',
        customerName: 'Test User',
        customerPhone: '555-0100',
        customerEmail: null,
      },
    });
    const response = await confirmSession(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.referenceNumber).toBeDefined();
    expect(body.data.status).toBe('submitted');
  });

  it('POST /api/session/confirm rejects a cross-origin request with 403 (CSRF guard)', async () => {
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');
    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/session/confirm',
      headers: { Origin: 'https://evil.com' },
      body: { issueType: 'cooling_not_working', urgency: 'high', description: 'x' },
    });
    const response = await confirmSession(request);
    expect(response.status).toBe(403);
    // The guard runs before the session is even loaded — no DB write happened.
    expect((await response.json()).error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('POST /api/session/confirm rejects a non-JSON content-type with 415', async () => {
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');
    // Same-origin but text/plain — the no-preflight form-POST vector.
    const request = new NextRequest(
      new URL('http://localhost:3000/api/session/confirm'),
      {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'text/plain',
        },
        body: '{"issueType":"cooling_not_working","urgency":"high","description":"x"}',
      },
    );
    const response = await confirmSession(request);
    expect(response.status).toBe(415);
  });

  it('POST /api/session/escalate escalates to human agent', async () => {
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');

    // Session lookup
    mockDbSelect.mockResolvedValueOnce([
      {
        id: MOCK_SESSION_ID,
        organizationId: DEMO_ORG_ID,
        token: 'mock-session-token-123',
        status: 'chatting',
        tokensUsed: 200,
        tokenBudget: 10000,
        turnCount: 5,
      },
    ]);

    // Update (now .returning() a row so the status-guarded escalate UPDATE
    // reports it actually transitioned) and audit log.
    mockDbUpdate.mockResolvedValue([{ id: MOCK_SESSION_ID }]);
    mockDbInsert.mockResolvedValue(undefined);

    // Override transition mock for escalation
    const { transition } = await import('@/lib/ai/state-machine');
    vi.mocked(transition).mockReturnValueOnce({ success: true, newState: 'escalated' });

    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/session/escalate',
    });
    const response = await escalateSession(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('escalated');
  });

  it('POST /api/auth/login authenticates admin user', async () => {
    mockDbSelect.mockResolvedValue([
      {
        id: 'admin-001',
        organizationId: DEMO_ORG_ID,
        email: 'admin@example.com',
        name: 'Admin User',
        role: 'admin',
        isActive: true,
        passwordHash: '$2a$12$hashedpassword',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/auth/login',
      body: { email: 'admin@example.com', password: 'correctpassword' },
    });
    const response = await adminLogin(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.user).toEqual({
      id: 'admin-001',
      name: 'Admin User',
      email: 'admin@example.com',
    });
  });

  it('GET /api/admin/requests shows submitted requests', async () => {
    mockGetAdminSession.mockResolvedValue(mockAdminSession);
    mockGetRequests.mockResolvedValue({
      requests: [
        {
          id: MOCK_REQUEST_ID,
          status: 'pending',
          issueType: 'cooling_not_working',
          urgency: 'high',
          description: 'AC not cooling',
          referenceNumber: 'HVAC-TEST1234',
          customerName: 'Test User',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    });

    const request = createMockRequest({
      url: 'http://localhost:3000/api/admin/requests?page=1&limit=10',
    });
    const response = await adminGetRequests(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.requests).toBeInstanceOf(Array);
    expect(body.data.requests.length).toBeGreaterThanOrEqual(1);
    expect(body.data.total).toBe(1);
  });

  it('POST /api/admin/requests/[id]/assign assigns a technician', async () => {
    mockGetAdminSession.mockResolvedValue(mockAdminSession);
    mockAssignTechnician.mockResolvedValue({
      ok: true,
      request: {
        id: MOCK_REQUEST_ID,
        status: 'assigned',
        issueType: 'cooling_not_working',
        urgency: 'high',
        description: 'AC not cooling',
        referenceNumber: 'HVAC-TEST1234',
        customerName: 'Test User',
        assignedToName: 'Tech A',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    });

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${MOCK_REQUEST_ID}/assign`,
      body: { technicianId: MOCK_TECH_ID },
    });
    const response = await assignTechHandler(request, {
      params: Promise.resolve({ id: MOCK_REQUEST_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('assigned');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'assign_technician',
        entity: 'service_request',
        entityId: MOCK_REQUEST_ID,
      }),
    );
  });

  it('GET /api/admin/stats returns dashboard statistics', async () => {
    mockGetAdminSession.mockResolvedValue(mockAdminSession);
    mockGetDashboardStats.mockResolvedValue({
      pending: 5,
      assignedToday: 3,
      inProgress: 2,
      completedToday: 1,
    });

    const response = await adminGetStats();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      pending: 5,
      assignedToday: 3,
      inProgress: 2,
      completedToday: 1,
    });
  });

  it('GET /api/admin/technicians returns technician list', async () => {
    mockGetAdminSession.mockResolvedValue(mockAdminSession);
    mockGetTechnicians.mockResolvedValue([
      { id: 't1', name: 'Tech A', email: 'a@x.com', isActive: true, createdAt: '2026-01-01T00:00:00Z' },
    ]);

    const response = await adminGetTechnicians();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.technicians).toHaveLength(1);
  });

  it('GET /api/cron/cleanup runs with valid CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';

    // Expire stale sessions
    mockDbUpdate.mockResolvedValueOnce({ rowCount: 2 });
    // Select stale sessions for purge
    mockDbSelect.mockResolvedValueOnce([]);

    const request = createMockRequest({
      url: 'http://localhost:3000/api/cron/cleanup',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const response = await cronCleanup(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('expiredSessions');
    expect(body.data).toHaveProperty('purgedSessions');
    expect(body.data).toHaveProperty('purgedMessages');
  });

  it('All error paths return structured API errors (no stack traces)', async () => {
    // Test 1: POST /api/session with DB error
    mockDbInsert.mockRejectedValueOnce(new Error('Connection refused'));

    const sessionRequest = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/session',
    });
    const sessionErrorResponse = await createSession(sessionRequest);
    const sessionErrorBody = await sessionErrorResponse.json();

    expect(sessionErrorBody.success).toBe(false);
    expect(sessionErrorBody.error).toBeDefined();
    expect(sessionErrorBody.error.message).toBeDefined();
    expect(sessionErrorBody.error.code).toBeDefined();

    // Verify no stack trace leakage
    const errorJson = JSON.stringify(sessionErrorBody);
    expect(errorJson).not.toContain('at ');
    expect(errorJson).not.toMatch(/Error:\s/);
    expect(errorJson).not.toContain('.ts:');
    expect(errorJson).not.toContain('.js:');

    // Test 2: POST /api/chat without session token (401)
    mockGetSessionToken.mockResolvedValue(null);

    const chatRequest = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/chat',
      body: { message: 'test' },
    });
    const chatErrorResponse = await sendChat(chatRequest);
    const chatErrorBody = await chatErrorResponse.json();

    expect(chatErrorResponse.status).toBe(401);
    expect(chatErrorBody.success).toBe(false);
    expect(chatErrorBody.error.code).toBe('NO_SESSION');

    // Test 3: GET /api/cron/cleanup without auth
    const cronRequest = createMockRequest({
      url: 'http://localhost:3000/api/cron/cleanup',
    });
    const cronErrorResponse = await cronCleanup(cronRequest);
    const cronErrorBody = await cronErrorResponse.json();

    expect(cronErrorResponse.status).toBe(401);
    expect(cronErrorBody.success).toBe(false);
    expect(cronErrorBody.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/session retrieves session with message history', async () => {
    mockGetSessionToken.mockResolvedValue('mock-session-token-123');

    // Session lookup
    mockDbSelect
      .mockResolvedValueOnce([
        {
          id: MOCK_SESSION_ID,
          organizationId: DEMO_ORG_ID,
          token: 'mock-session-token-123',
          status: 'chatting',
          tokensUsed: 200,
          tokenBudget: 10000,
          turnCount: 2,
        },
      ])
      // Message history
      .mockResolvedValueOnce([
        { role: 'user', content: 'My AC is broken', createdAt: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'I can help with that.', createdAt: '2026-01-01T00:00:01Z' },
      ]);

    const request = createMockRequest({
      url: 'http://localhost:3000/api/session',
    });
    const response = await getSession(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.sessionId).toBe(MOCK_SESSION_ID);
    expect(body.data.status).toBe('chatting');
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.messages[0].role).toBe('user');
    expect(body.data.messages[1].role).toBe('assistant');
  });
});
