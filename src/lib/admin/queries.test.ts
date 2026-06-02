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
  sql: vi.fn(),
  count: vi.fn(() => 'count'),
  desc: vi.fn((col: unknown) => col),
  asc: vi.fn((col: unknown) => col),
  gte: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  ilike: vi.fn((...args: unknown[]) => args),
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
  requestStatusEnum: {
    enumValues: ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'],
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
  it('should return { pending, assignedToday, inProgress, completedToday } shape', async () => {
    // getDashboardStats makes 4 select calls (pending, assignedToday, inProgress, completedToday)
    selectResolutions = [
      [{ value: 5 }],
      [{ value: 3 }],
      [{ value: 2 }],
      [{ value: 1 }],
    ];

    const result = await getDashboardStats(ORG_ID);
    expect(result).toHaveProperty('pending');
    expect(result).toHaveProperty('assignedToday');
    expect(result).toHaveProperty('inProgress');
    expect(result).toHaveProperty('completedToday');
    expect(typeof result.pending).toBe('number');
    expect(typeof result.assignedToday).toBe('number');
    expect(typeof result.inProgress).toBe('number');
    expect(typeof result.completedToday).toBe('number');
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
});

describe('scheduleRequest', () => {
  it('returns request_not_found when the update matches nothing', async () => {
    updateResolution = [];
    const result = await scheduleRequest(ORG_ID, 'req-x', new Date('2026-07-01T00:00:00Z'));
    expect(result).toEqual({ ok: false, reason: 'request_not_found' });
  });

  it('sets a scheduled date and returns it as ISO', async () => {
    const when = new Date('2026-07-01T00:00:00.000Z');
    updateResolution = [{ scheduledDate: when }];
    const result = await scheduleRequest(ORG_ID, 'req-1', when);
    expect(result).toEqual({ ok: true, scheduledDate: '2026-07-01T00:00:00.000Z' });
  });

  it('clears a scheduled date (null) and returns null', async () => {
    updateResolution = [{ scheduledDate: null }];
    const result = await scheduleRequest(ORG_ID, 'req-1', null);
    expect(result).toEqual({ ok: true, scheduledDate: null });
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
