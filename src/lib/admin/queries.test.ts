import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock setup ---

// Mock bcryptjs so we can verify hashing behavior
const mockHash = vi.fn().mockResolvedValue('$2a$12$hashed');
vi.mock('bcryptjs', () => ({
  hash: (...args: unknown[]) => mockHash(...args),
  default: { hash: (...args: unknown[]) => mockHash(...args) },
}));

// Mock crypto module used by queries.ts
vi.mock('@/lib/crypto', () => ({
  decrypt: vi.fn((val: string) => `decrypted_${val}`),
}));

// Mock tenant helper — return a truthy SQL placeholder
vi.mock('@/lib/db/tenant', () => ({
  withTenant: vi.fn(() => 'mock-tenant-condition'),
}));

// Chainable mock builders for Drizzle-like API
function createChainableMock(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const proxy = new Proxy(chain, {
    get(_target, prop) {
      if (prop === 'then') {
        // Make it thenable — resolve with the configured value
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      // Every other property returns a function that returns the proxy
      return () => proxy;
    },
  });
  return proxy;
}

// We need per-call resolution, so track call sequences
let selectCallIndex = 0;
let selectResolutions: unknown[][] = [[]];
let insertResolution: unknown = [];
let updateResolution: unknown = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: (..._args: unknown[]) => {
      const idx = selectCallIndex;
      selectCallIndex++;
      return createChainableMock(
        idx < selectResolutions.length ? selectResolutions[idx] : [],
      );
    },
    insert: (..._args: unknown[]) => createChainableMock(insertResolution),
    update: (..._args: unknown[]) => createChainableMock(updateResolution),
  },
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  // sql is used both as a tagged-template (sql`...`) and as sql<T>`...`; a plain
  // mock fn satisfies both call shapes.
  sql: vi.fn((...args: unknown[]) => args),
  count: vi.fn(() => 'count'),
  desc: vi.fn((col: unknown) => col),
  asc: vi.fn((col: unknown) => col),
  gt: vi.fn((...args: unknown[]) => args),
  gte: vi.fn((...args: unknown[]) => args),
  lt: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  ilike: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((...args: unknown[]) => args),
  isNotNull: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
}));

// Mock schema tables — provide column-like objects
vi.mock('@/lib/db/schema', () => ({
  serviceRequests: {
    id: 'sr.id',
    status: 'sr.status',
    issueType: 'sr.issueType',
    urgency: 'sr.urgency',
    description: 'sr.description',
    referenceNumber: 'sr.referenceNumber',
    customerNameEncrypted: 'sr.customerNameEncrypted',
    customerPhoneEncrypted: 'sr.customerPhoneEncrypted',
    customerEmailEncrypted: 'sr.customerEmailEncrypted',
    addressEncrypted: 'sr.addressEncrypted',
    assignedTo: 'sr.assignedTo',
    assignedToName: 'sr.assignedToName',
    scheduledDate: 'sr.scheduledDate',
    arrivalWindowStart: 'sr.arrivalWindowStart',
    arrivalWindowEnd: 'sr.arrivalWindowEnd',
    holdReason: 'sr.holdReason',
    followUpDate: 'sr.followUpDate',
    isAfterHours: 'sr.isAfterHours',
    afterHoursSurcharge: 'sr.afterHoursSurcharge',
    completedAt: 'sr.completedAt',
    createdAt: 'sr.createdAt',
    updatedAt: 'sr.updatedAt',
    sessionId: 'sr.sessionId',
    organizationId: 'sr.organizationId',
  },
  users: {
    id: 'u.id',
    name: 'u.name',
    email: 'u.email',
    role: 'u.role',
    isActive: 'u.isActive',
    passwordHash: 'u.passwordHash',
    organizationId: 'u.organizationId',
    createdAt: 'u.createdAt',
  },
  messages: {
    role: 'm.role',
    content: 'm.content',
    createdAt: 'm.createdAt',
    sessionId: 'm.sessionId',
    organizationId: 'm.organizationId',
  },
  requestNotes: {
    id: 'rn.id',
    requestId: 'rn.requestId',
    organizationId: 'rn.organizationId',
    authorId: 'rn.authorId',
    content: 'rn.content',
    createdAt: 'rn.createdAt',
  },
  technicianAvailability: {
    id: 'ta.id',
    organizationId: 'ta.org',
    technicianId: 'ta.tech',
    dayOfWeek: 'ta.dow',
    startMinute: 'ta.start',
    endMinute: 'ta.end',
  },
  requestStatusEnum: {
    enumValues: [
      'pending',
      'assigned',
      'scheduled',
      'in_progress',
      'on_hold',
      'completed',
      'cancelled',
    ],
  },
  holdReasonEnum: {
    enumValues: [
      'awaiting_parts',
      'awaiting_customer',
      'awaiting_access',
      'weather',
      'other',
    ],
  },
}));

// Import the module under test AFTER mocks are set up
import {
  getRequests,
  getRequestById,
  assignTechnician,
  reassignTechnician,
  updateRequestStatus,
  scheduleRequest,
  addRequestNote,
  getTechnicians,
  createTechnician,
  updateTechnician,
  getDashboardStats,
  getDashboardOverview,
  getDispatchBoard,
  getSchedulingCalendar,
  countUnscheduledRequests,
} from '@/lib/admin/queries';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  selectCallIndex = 0;
  selectResolutions = [[]];
  insertResolution = [];
  updateResolution = [];
});

describe('getRequests', () => {
  it('should return { requests, total } shape with empty results', async () => {
    // First select = count query, second select = rows query
    selectResolutions = [[{ value: 0 }], []];

    const result = await getRequests(ORG_ID, {});
    expect(result).toHaveProperty('requests');
    expect(result).toHaveProperty('total');
    expect(typeof result.total).toBe('number');
    expect(Array.isArray(result.requests)).toBe(true);
    expect(result.requests).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('should accept status filter parameter', async () => {
    selectResolutions = [[{ value: 0 }], []];

    // Should not throw when status filter is provided
    const result = await getRequests(ORG_ID, { status: 'pending' });
    expect(result).toHaveProperty('requests');
    expect(result).toHaveProperty('total');
  });

  it('should return correct total from count query', async () => {
    const now = new Date();
    selectResolutions = [
      [{ value: 2 }],
      [
        {
          id: 'req-1',
          status: 'pending',
          issueType: 'heating',
          urgency: 'medium',
          description: 'Test',
          referenceNumber: 'REF-001',
          customerNameEncrypted: 'enc_name',
          assignedToName: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    ];

    const result = await getRequests(ORG_ID, {});
    expect(result.total).toBe(2);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toHaveProperty('id', 'req-1');
    expect(result.requests[0]).toHaveProperty('customerName');
    expect(typeof result.requests[0].createdAt).toBe('string');
  });

  it('applies a reference-number prefix search, escaping LIKE metacharacters', async () => {
    const { ilike } = await import('drizzle-orm');
    selectResolutions = [[{ value: 0 }], []];

    await getRequests(ORG_ID, { search: '  hvac_50%  ' });

    // Trimmed; "_" and "%" escaped; appended with a trailing "%" for prefix.
    expect(ilike).toHaveBeenCalledWith(
      expect.anything(),
      'hvac\\_50\\%%',
    );
  });

  it('does not search when the term is blank after trimming', async () => {
    const { ilike } = await import('drizzle-orm');
    vi.mocked(ilike).mockClear();
    selectResolutions = [[{ value: 0 }], []];

    await getRequests(ORG_ID, { search: '   ' });
    expect(ilike).not.toHaveBeenCalled();
  });
});

describe('getRequestById', () => {
  it('should return null when request not found', async () => {
    selectResolutions = [[]]; // empty array = no row found

    const result = await getRequestById(ORG_ID, 'nonexistent-id');
    expect(result).toBeNull();
  });
});

describe('assignTechnician', () => {
  it('should fail with technician_not_found when the assignee is not an active technician in the org', async () => {
    selectResolutions = [[]]; // tech lookup (role+active+tenant) returns nothing

    const result = await assignTechnician(ORG_ID, 'req-1', 'tech-nonexistent');
    expect(result).toEqual({ ok: false, reason: 'technician_not_found' });
  });

  it('should assign when the technician is valid and the request is pending', async () => {
    const now = new Date();
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }], // tech lookup succeeds
    ];
    updateResolution = [
      {
        id: 'req-1',
        status: 'assigned',
        issueType: 'no_cooling',
        urgency: 'high',
        description: 'AC out',
        referenceNumber: 'HVAC-ABCD1234',
        customerNameEncrypted: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await assignTechnician(ORG_ID, 'req-1', 'tech-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.status).toBe('assigned');
      expect(result.request.assignedToName).toBe('John Tech');
    }
  });

  it('should report request_not_assignable when the request exists but is not in an assignable state', async () => {
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }], // tech lookup succeeds
      [{ status: 'in_progress' }], // disambiguation lookup after empty update
    ];
    updateResolution = []; // status guard matched zero rows

    const result = await assignTechnician(ORG_ID, 'req-1', 'tech-1');
    expect(result).toEqual({
      ok: false,
      reason: 'request_not_assignable',
      currentStatus: 'in_progress',
    });
  });

  it('should report request_not_found when neither the update nor the lookup find the request', async () => {
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }], // tech lookup succeeds
      [], // disambiguation lookup finds nothing
    ];
    updateResolution = []; // update matched zero rows

    const result = await assignTechnician(ORG_ID, 'req-1', 'req-nonexistent');
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });
});

describe('reassignTechnician', () => {
  it('fails with technician_not_found when the assignee is not an active technician', async () => {
    selectResolutions = [[]]; // tech lookup returns nothing
    const result = await reassignTechnician(ORG_ID, 'req-1', 'tech-x');
    expect(result).toEqual({ ok: false, reason: 'technician_not_found' });
  });

  it('reassigns an in_progress request WITHOUT resetting its status', async () => {
    const now = new Date();
    selectResolutions = [[{ id: 'tech-2', name: 'Jane Tech' }]];
    updateResolution = [
      {
        id: 'req-1',
        status: 'in_progress', // preserved — NOT reset to "assigned"
        issueType: 'no_cooling',
        urgency: 'high',
        description: 'AC out',
        referenceNumber: 'HVAC-ABCD1234',
        customerNameEncrypted: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await reassignTechnician(ORG_ID, 'req-1', 'tech-2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.status).toBe('in_progress');
      expect(result.request.assignedToName).toBe('Jane Tech');
    }
  });

  it('reassigns an "assigned" request, preserving the assigned status', async () => {
    const now = new Date();
    selectResolutions = [[{ id: 'tech-3', name: 'Carlos Tech' }]];
    updateResolution = [
      {
        id: 'req-2',
        status: 'assigned', // stays assigned (assigned is also reassignable)
        issueType: 'heating',
        urgency: 'medium',
        description: 'No heat',
        referenceNumber: 'HVAC-WXYZ9876',
        customerNameEncrypted: null,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await reassignTechnician(ORG_ID, 'req-2', 'tech-3');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.status).toBe('assigned');
      expect(result.request.assignedToName).toBe('Carlos Tech');
    }
  });

  it('reports request_not_reassignable for a pending (unassigned) request', async () => {
    selectResolutions = [
      [{ id: 'tech-2', name: 'Jane Tech' }], // tech ok
      [{ status: 'pending' }], // disambiguation: pending is not reassignable
    ];
    updateResolution = []; // status guard matched zero rows

    const result = await reassignTechnician(ORG_ID, 'req-1', 'tech-2');
    expect(result).toEqual({
      ok: false,
      reason: 'request_not_reassignable',
      currentStatus: 'pending',
    });
  });

  it('reports request_not_found when the request does not exist in the org', async () => {
    selectResolutions = [
      [{ id: 'tech-2', name: 'Jane Tech' }],
      [], // disambiguation finds nothing
    ];
    updateResolution = [];

    const result = await reassignTechnician(ORG_ID, 'req-x', 'tech-2');
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });
});

describe('getTechnicians', () => {
  it('should return an array', async () => {
    const now = new Date();
    selectResolutions = [[
      {
        id: 'tech-1',
        name: 'John Tech',
        email: 'john@example.com',
        isActive: true,
        createdAt: now,
      },
    ]];

    const result = await getTechnicians(ORG_ID);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'tech-1',
      name: 'John Tech',
      email: 'john@example.com',
      isActive: true,
      createdAt: now.toISOString(),
    });
  });

  it('should return TechnicianRecord shape for each row', async () => {
    const now = new Date();
    selectResolutions = [[
      { id: 't1', name: 'A', email: 'a@x.com', isActive: true, createdAt: now },
      { id: 't2', name: 'B', email: 'b@x.com', isActive: false, createdAt: now },
    ]];

    const result = await getTechnicians(ORG_ID);
    for (const tech of result) {
      expect(tech).toHaveProperty('id');
      expect(tech).toHaveProperty('name');
      expect(tech).toHaveProperty('email');
      expect(tech).toHaveProperty('isActive');
      expect(tech).toHaveProperty('createdAt');
      expect(typeof tech.createdAt).toBe('string');
    }
  });
});

describe('createTechnician', () => {
  it('should hash password with bcrypt using salt rounds 12', async () => {
    const now = new Date();
    insertResolution = [
      {
        id: 'new-tech-1',
        name: 'New Tech',
        email: 'new@example.com',
        isActive: true,
        createdAt: now,
      },
    ];

    await createTechnician(ORG_ID, {
      name: 'New Tech',
      email: 'new@example.com',
      password: 'securePassword123',
    });

    expect(mockHash).toHaveBeenCalledWith('securePassword123', 12);
  });

  it('should return TechnicianRecord shape on success', async () => {
    const now = new Date();
    insertResolution = [
      {
        id: 'new-tech-2',
        name: 'Another Tech',
        email: 'another@example.com',
        isActive: true,
        createdAt: now,
      },
    ];

    const result = await createTechnician(ORG_ID, {
      name: 'Another Tech',
      email: 'another@example.com',
      password: 'password1234',
    });

    expect(result).toEqual({
      id: 'new-tech-2',
      name: 'Another Tech',
      email: 'another@example.com',
      isActive: true,
      createdAt: now.toISOString(),
    });
  });
});

describe('updateTechnician', () => {
  it('should return null when technician not found', async () => {
    updateResolution = []; // empty = no row updated

    const result = await updateTechnician(ORG_ID, 'nonexistent', { name: 'New Name' });
    expect(result).toBeNull();
  });
});

describe('getDashboardStats', () => {
  it('should return the full KPI shape with numeric values', async () => {
    // 9 select calls: pending, assignedToday, inProgress, completedToday,
    // scheduled, onHold, emergencyOpen, afterHoursToday (count + surcharge sum).
    selectResolutions = [
      [{ value: 5 }], // pending
      [{ value: 3 }], // assignedToday
      [{ value: 2 }], // inProgress
      [{ value: 1 }], // completedToday
      [{ value: 4 }], // scheduled
      [{ value: 2 }], // onHold
      [{ value: 1 }], // emergencyOpen
      [{ value: 3, surcharge: 450 }], // afterHoursToday + surchargeToday
    ];

    const result = await getDashboardStats(ORG_ID);
    expect(result.pending).toBe(5);
    expect(result.assignedToday).toBe(3);
    expect(result.inProgress).toBe(2);
    expect(result.completedToday).toBe(1);
    expect(result.scheduled).toBe(4);
    expect(result.onHold).toBe(2);
    expect(result.emergencyOpen).toBe(1);
    expect(result.afterHoursToday).toBe(3);
    expect(result.surchargeToday).toBe(450);
  });

  it('defaults surchargeToday to 0 when no after-hours rows exist', async () => {
    selectResolutions = [
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0, surcharge: 0 }],
    ];

    const result = await getDashboardStats(ORG_ID);
    expect(result.afterHoursToday).toBe(0);
    expect(result.surchargeToday).toBe(0);
  });
});

describe('getDashboardOverview', () => {
  it('returns stats plus three mapped request lists', async () => {
    // First 8 selects feed getDashboardStats; then 3 list selects.
    const scheduledRow = {
      id: 'req-1',
      referenceNumber: 'HVAC-001',
      customerNameEncrypted: 'enc-name',
      issueType: 'no_cooling',
      urgency: 'high',
      status: 'scheduled',
      isAfterHours: true,
      assignedToName: 'Tech A',
      arrivalWindowStart: new Date('2026-06-08T13:00:00.000Z'),
      arrivalWindowEnd: new Date('2026-06-08T17:00:00.000Z'),
      followUpDate: null,
      holdReason: null,
      createdAt: new Date('2026-06-07T10:00:00.000Z'),
    };
    selectResolutions = [
      [{ value: 1 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 1 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 1, surcharge: 150 }],
      [scheduledRow], // todaySchedule
      [], // needsAttention
      [], // awaitingFollowUp
    ];

    const result = await getDashboardOverview(ORG_ID);
    expect(result.stats.pending).toBe(1);
    expect(result.todaySchedule).toHaveLength(1);
    expect(result.todaySchedule[0].referenceNumber).toBe('HVAC-001');
    // Customer name is decrypted (the crypto mock prefixes 'decrypted_').
    expect(result.todaySchedule[0].customerName).toBe('decrypted_enc-name');
    expect(result.todaySchedule[0].arrivalWindowStart).toBe(
      '2026-06-08T13:00:00.000Z',
    );
    expect(result.needsAttention).toEqual([]);
    expect(result.awaitingFollowUp).toEqual([]);
  });

  it('scopes the needs-attention queue to UNASSIGNED requests', async () => {
    // The "needs attention" queue must filter on assignedTo IS NULL — an
    // assigned-but-urgent request should never surface here. We assert the
    // query was built with isNull(assignedTo) rather than relying on the mock
    // to execute SQL filtering.
    const { isNull } = await import('drizzle-orm');
    selectResolutions = [
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0, surcharge: 0 }],
      [], // todaySchedule
      [], // needsAttention
      [], // awaitingFollowUp
    ];

    await getDashboardOverview(ORG_ID);
    expect(isNull).toHaveBeenCalledWith('sr.assignedTo');
  });
});

describe('getDispatchBoard', () => {
  const TECH_A = '00000000-0000-0000-0000-0000000000a1';
  const TECH_B = '00000000-0000-0000-0000-0000000000b2';

  function jobRow(overrides: Record<string, unknown>) {
    return {
      id: 'job',
      referenceNumber: 'HVAC-X',
      customerNameEncrypted: 'enc',
      issueType: 'no_cooling',
      urgency: 'medium',
      status: 'scheduled',
      isAfterHours: false,
      assignedToName: null,
      arrivalWindowStart: new Date('2026-06-10T13:00:00.000Z'),
      arrivalWindowEnd: new Date('2026-06-10T17:00:00.000Z'),
      followUpDate: null,
      holdReason: null,
      createdAt: new Date('2026-06-09T10:00:00.000Z'),
      assignedTo: null,
      ...overrides,
    };
  }

  it('buckets jobs into active-tech columns and an unassigned pile', async () => {
    // select 0 = getTechnicians; select 1 = job rows.
    selectResolutions = [
      [
        { id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() },
        { id: TECH_B, name: 'Bob', email: 'b@x.io', isActive: false, createdAt: new Date() },
      ],
      [
        jobRow({ id: 'j1', referenceNumber: 'HVAC-1', assignedTo: TECH_A }),
        // Assigned to an INACTIVE tech → must fall to unassigned, not vanish.
        jobRow({ id: 'j2', referenceNumber: 'HVAC-2', assignedTo: TECH_B }),
        // No tech at all → unassigned.
        jobRow({ id: 'j3', referenceNumber: 'HVAC-3', assignedTo: null }),
      ],
    ];

    const board = await getDispatchBoard(ORG_ID, '2026-06-10');

    expect(board.date).toBe('2026-06-10');
    // Only the active tech gets a column.
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].technicianId).toBe(TECH_A);
    expect(board.columns[0].jobs.map((j) => j.referenceNumber)).toEqual(['HVAC-1']);
    // Inactive-tech job + truly-unassigned job both land in the pile.
    expect(board.unassigned.map((j) => j.referenceNumber).sort()).toEqual([
      'HVAC-2',
      'HVAC-3',
    ]);
  });

  it('gives every active tech a column even with zero jobs', async () => {
    selectResolutions = [
      [
        { id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() },
      ],
      [],
    ];

    const board = await getDispatchBoard(ORG_ID, '2026-06-10');
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].jobs).toEqual([]);
    expect(board.unassigned).toEqual([]);
  });

  it('falls back to today for an invalid date string', async () => {
    selectResolutions = [[], []];
    const board = await getDispatchBoard(ORG_ID, 'not-a-date');
    // Today's UTC date — matches the YYYY-MM-DD shape, not the bad input.
    expect(board.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(board.date).not.toBe('not-a-date');
  });

  it('rejects overflow calendar dates and falls back to today', async () => {
    selectResolutions = [[], []];
    const board = await getDispatchBoard(ORG_ID, '2026-02-30');
    expect(board.date).not.toBe('2026-02-30');
  });
});

describe('getSchedulingCalendar', () => {
  const TECH_A = '00000000-0000-0000-0000-0000000000a1';
  const TECH_B = '00000000-0000-0000-0000-0000000000b2';
  const START = '2026-06-07T04:00:00.000Z';
  const END = '2026-06-14T04:00:00.000Z';
  const DAYS = ['2026-06-07', '2026-06-08'] as const;

  function placedRow(overrides: Record<string, unknown>) {
    return {
      id: 'job',
      referenceNumber: 'HVAC-X',
      customerNameEncrypted: 'enc',
      issueType: 'no_cooling',
      urgency: 'medium',
      status: 'scheduled',
      isAfterHours: false,
      assignedToName: null,
      arrivalWindowStart: new Date('2026-06-08T13:00:00.000Z'),
      arrivalWindowEnd: new Date('2026-06-08T17:00:00.000Z'),
      followUpDate: null,
      holdReason: null,
      createdAt: new Date('2026-06-07T10:00:00.000Z'),
      assignedTo: null,
      ...overrides,
    };
  }

  it('buckets placed jobs into tech lanes + unassigned and returns the days', async () => {
    // select 0 = getTechnicians; 1 = placed jobs; 2 = unscheduled list.
    selectResolutions = [
      [
        { id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() },
        { id: TECH_B, name: 'Bob', email: 'b@x.io', isActive: false, createdAt: new Date() },
      ],
      [
        placedRow({ id: 'j1', referenceNumber: 'HVAC-1', assignedTo: TECH_A }),
        // Inactive-tech job falls to the unassigned lane, not its own column.
        placedRow({ id: 'j2', referenceNumber: 'HVAC-2', assignedTo: TECH_B }),
        placedRow({ id: 'j3', referenceNumber: 'HVAC-3', assignedTo: null }),
      ],
      [
        placedRow({
          id: 'u1',
          referenceNumber: 'HVAC-9',
          assignedTo: null,
          arrivalWindowStart: null,
          arrivalWindowEnd: null,
          status: 'pending',
        }),
      ],
    ];

    const calendar = await getSchedulingCalendar(ORG_ID, START, END, [...DAYS]);

    expect(calendar.days).toEqual([...DAYS]);
    // Only the active tech gets a lane.
    expect(calendar.lanes).toHaveLength(1);
    expect(calendar.lanes[0].technicianId).toBe(TECH_A);
    expect(calendar.lanes[0].jobs.map((j) => j.referenceNumber)).toEqual(['HVAC-1']);
    expect(calendar.unassigned.map((j) => j.referenceNumber).sort()).toEqual([
      'HVAC-2',
      'HVAC-3',
    ]);
    expect(calendar.unscheduled.map((j) => j.referenceNumber)).toEqual(['HVAC-9']);
    // S4: availability now travels with the calendar (drives out-of-hours
    // shading + the conflict warning). None configured in this fixture → empty.
    expect(calendar.availability).toEqual([]);
  });

  it('carries technician availability for out-of-hours shading (S4)', async () => {
    // select 0 = techs; 1 = placed; 2 = unscheduled; 3 = availability.
    selectResolutions = [
      [{ id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() }],
      [],
      [],
      [
        { id: 'av1', technicianId: TECH_A, dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
      ],
    ];

    const calendar = await getSchedulingCalendar(ORG_ID, START, END, [...DAYS]);
    expect(calendar.availability).toEqual([
      { id: 'av1', technicianId: TECH_A, dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
    ]);
  });

  it('throws on an invalid range rather than querying garbage', async () => {
    selectResolutions = [[], [], []];
    await expect(
      getSchedulingCalendar(ORG_ID, 'not-a-date', END, [...DAYS]),
    ).rejects.toThrow('Invalid calendar range');
  });

  it('selects placed jobs by a half-open OVERLAP, not a point test on start', async () => {
    // HIGH-2 regression: the placed-jobs filter must be a half-open OVERLAP
    // (window.start < rangeEnd AND window.end > rangeStart), consistent with
    // checkScheduleConflict — NOT a point test on the start (which dropped a job
    // starting before the range whose window extended into it). We assert the
    // operators were invoked on the right (column, bound) pairs.
    selectResolutions = [
      [{ id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() }],
      [],
      [],
      [],
    ];

    const { gt, lt, gte } = await import('drizzle-orm');
    vi.mocked(gt).mockClear();
    vi.mocked(lt).mockClear();
    vi.mocked(gte).mockClear();

    await getSchedulingCalendar(ORG_ID, START, END, [...DAYS]);

    const startInstant = new Date(START);
    const endInstant = new Date(END);

    // window.start < rangeEnd  → lt(arrivalWindowStart, end)
    expect(vi.mocked(lt)).toHaveBeenCalledWith(
      'sr.arrivalWindowStart',
      endInstant,
    );
    // window.end > rangeStart  → gt(arrivalWindowEnd, start)
    expect(vi.mocked(gt)).toHaveBeenCalledWith(
      'sr.arrivalWindowEnd',
      startInstant,
    );
    // The old POINT test (gte on the START column) must be gone.
    expect(vi.mocked(gte)).not.toHaveBeenCalledWith(
      'sr.arrivalWindowStart',
      startInstant,
    );
  });
});

describe('countUnscheduledRequests', () => {
  it('returns the count value from the aggregate query', async () => {
    selectResolutions = [[{ value: 7 }]];
    const result = await countUnscheduledRequests(ORG_ID);
    expect(result).toBe(7);
  });

  it('defaults to 0 when the aggregate returns no row', async () => {
    selectResolutions = [[]];
    const result = await countUnscheduledRequests(ORG_ID);
    expect(result).toBe(0);
  });
});

describe('updateRequestStatus', () => {
  it('returns request_not_found when the request is absent', async () => {
    selectResolutions = [[]]; // existence check → no row
    const result = await updateRequestStatus(ORG_ID, 'req-x', 'in_progress');
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });

  it('rejects an illegal transition (pending → completed) without writing', async () => {
    selectResolutions = [[{ status: 'pending' }]];
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'completed');
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_transition',
      currentStatus: 'pending',
    });
  });

  it('transitions assigned → in_progress when the guarded update matches', async () => {
    selectResolutions = [[{ status: 'assigned' }]];
    updateResolution = [{ status: 'in_progress' }];
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'in_progress');
    expect(result).toEqual({ ok: true, status: 'in_progress' });
  });

  it('reports invalid_transition when a concurrent write moved the row (update matched zero)', async () => {
    selectResolutions = [[{ status: 'assigned' }]]; // legal at read time
    updateResolution = []; // but the guarded update matched nothing
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'in_progress');
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_transition',
      currentStatus: 'assigned',
    });
  });

  it('completes from in_progress', async () => {
    selectResolutions = [[{ status: 'in_progress' }]];
    updateResolution = [{ status: 'completed' }];
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'completed');
    expect(result).toEqual({ ok: true, status: 'completed' });
  });

  it('puts an in_progress job on hold with reason + follow-up', async () => {
    selectResolutions = [[{ status: 'in_progress' }]];
    updateResolution = [{ status: 'on_hold' }];
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'on_hold', {
      reason: 'awaiting_parts',
      followUpDate: new Date('2026-07-05T00:00:00Z'),
    });
    expect(result).toEqual({ ok: true, status: 'on_hold' });
  });

  it('resumes a held job (on_hold → in_progress)', async () => {
    selectResolutions = [[{ status: 'on_hold' }]];
    updateResolution = [{ status: 'in_progress' }];
    const result = await updateRequestStatus(ORG_ID, 'req-1', 'in_progress');
    expect(result).toEqual({ ok: true, status: 'in_progress' });
  });
});

describe('scheduleRequest', () => {
  it('returns request_not_found when the update matches nothing', async () => {
    updateResolution = [];
    const result = await scheduleRequest(ORG_ID, 'req-x', new Date('2026-07-01T00:00:00Z'));
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });

  it('sets a scheduled date and returns it as ISO', async () => {
    const when = new Date('2026-07-01T00:00:00.000Z');
    updateResolution = [
      { scheduledDate: when, arrivalWindowStart: null, arrivalWindowEnd: null },
    ];
    const result = await scheduleRequest(ORG_ID, 'req-1', when);
    expect(result).toEqual({
      ok: true,
      scheduledDate: '2026-07-01T00:00:00.000Z',
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    });
  });

  it('clears a scheduled date (null) and returns null', async () => {
    updateResolution = [
      { scheduledDate: null, arrivalWindowStart: null, arrivalWindowEnd: null },
    ];
    const result = await scheduleRequest(ORG_ID, 'req-1', null);
    expect(result).toEqual({
      ok: true,
      scheduledDate: null,
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    });
  });

  it('sets an arrival window (start/end) alongside the date', async () => {
    const when = new Date('2026-07-01T00:00:00.000Z');
    const start = new Date('2026-07-01T08:00:00.000Z');
    const end = new Date('2026-07-01T12:00:00.000Z');
    updateResolution = [
      { scheduledDate: when, arrivalWindowStart: start, arrivalWindowEnd: end },
    ];
    const result = await scheduleRequest(ORG_ID, 'req-1', when, { start, end });
    expect(result).toEqual({
      ok: true,
      scheduledDate: '2026-07-01T00:00:00.000Z',
      arrivalWindowStart: '2026-07-01T08:00:00.000Z',
      arrivalWindowEnd: '2026-07-01T12:00:00.000Z',
    });
  });
});

describe('addRequestNote', () => {
  it('returns request_not_found when the request is not in the org', async () => {
    selectResolutions = [[]]; // existence check → no row
    const result = await addRequestNote(ORG_ID, 'req-x', 'admin-1', 'hello');
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });

  it('creates the note and returns it with the author name', async () => {
    const when = new Date('2026-06-02T12:00:00.000Z');
    selectResolutions = [
      [{ id: 'req-1' }], // #1 existence check
      [{ name: 'Dispatcher Dan' }], // #2 author lookup
    ];
    insertResolution = [{ id: 'note-1', createdAt: when }];

    const result = await addRequestNote(
      ORG_ID,
      'req-1',
      'admin-1',
      'Customer prefers morning visits',
    );
    expect(result).toEqual({
      ok: true,
      note: {
        id: 'note-1',
        content: 'Customer prefers morning visits',
        authorName: 'Dispatcher Dan',
        createdAt: '2026-06-02T12:00:00.000Z',
      },
    });
  });

  it('returns a null authorName when the author lookup misses', async () => {
    const when = new Date('2026-06-02T12:00:00.000Z');
    selectResolutions = [
      [{ id: 'req-1' }], // existence
      [], // author lookup → none
    ];
    insertResolution = [{ id: 'note-2', createdAt: when }];

    const result = await addRequestNote(ORG_ID, 'req-1', 'admin-x', 'note');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note.authorName).toBeNull();
    }
  });
});
