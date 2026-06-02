import { describe, it, expect, vi, beforeEach } from 'vitest';

// bcrypt hash is mocked so tests don't pay the real cost and we can assert the
// plaintext is hashed, never persisted raw.
const mockHash = vi.fn().mockResolvedValue('$2a$12$hashed');
vi.mock('bcryptjs', () => ({
  hash: (...args: unknown[]) => mockHash(...args),
  default: { hash: (...args: unknown[]) => mockHash(...args) },
}));

vi.mock('@/lib/db/tenant', () => ({
  // Echo the extra conditions so assertions can inspect them if needed.
  withTenant: (_table: unknown, _orgId: string, ...c: unknown[]) => c,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  and: (...a: unknown[]) => ['and', ...a],
  ne: (...a: unknown[]) => ['ne', ...a],
  count: () => 'count',
  asc: (c: unknown) => c,
}));

vi.mock('@/lib/db/schema', () => ({
  users: {
    id: 'u.id',
    name: 'u.name',
    email: 'u.email',
    role: 'u.role',
    isActive: 'u.isActive',
    passwordHash: 'u.passwordHash',
    createdAt: 'u.createdAt',
    organizationId: 'u.org',
  },
}));

// --- Chainable db mock with per-call result queues ---
// A queued value that is an Error makes the awaited chain REJECT with it,
// letting us simulate the DB trigger raising on a write.
const selectQueue: unknown[] = [];
const insertQueue: unknown[] = [];
const updateQueue: unknown[] = [];

function chain(resolved: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (
          resolve: (v: unknown) => void,
          reject: (e: unknown) => void,
        ) => {
          if (resolved instanceof Error) reject(resolved);
          else resolve(resolved);
        };
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
    insert: () => chain(insertQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
  },
}));

import {
  listStaff,
  createStaff,
  updateStaff,
  resetStaffPassword,
  normalizeEmail,
  BCRYPT_COST,
} from './staff-queries';

const ORG = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-0000000000aa';

function row(over: Record<string, unknown> = {}) {
  return {
    id: USER,
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  mockHash.mockClear();
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('listStaff', () => {
  it('returns an empty array when there are no staff', async () => {
    selectQueue.push([]);
    const staff = await listStaff(ORG);
    expect(staff).toEqual([]);
  });

  it('maps rows to StaffRecord with ISO dates', async () => {
    selectQueue.push([row(), row({ id: 'x', role: 'technician', name: 'Bob' })]);
    const staff = await listStaff(ORG);
    expect(staff).toHaveLength(2);
    expect(staff[0]).toEqual({
      id: USER,
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('createStaff', () => {
  it('rejects a duplicate email in the same org without hashing', async () => {
    selectQueue.push([{ id: 'existing' }]); // collision pre-check finds a row
    const r = await createStaff(ORG, {
      name: 'Dup',
      email: 'Dup@Example.com',
      password: 'password123',
      role: 'admin',
    });
    expect(r).toEqual({ ok: false, reason: 'email_conflict' });
    expect(mockHash).not.toHaveBeenCalled();
  });

  it('hashes the password and stores a normalized email on success', async () => {
    selectQueue.push([]); // no collision
    insertQueue.push([
      row({ email: 'new@example.com', name: 'New', role: 'technician' }),
    ]);
    const r = await createStaff(ORG, {
      name: 'New',
      email: '  New@Example.com ',
      password: 'password123',
      role: 'technician',
    });
    expect(mockHash).toHaveBeenCalledWith('password123', BCRYPT_COST);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.staff.role).toBe('technician');
      expect(r.staff.email).toBe('new@example.com');
    }
  });

  it('throws if the insert returns no row', async () => {
    selectQueue.push([]); // no collision
    insertQueue.push([]); // insert resolves empty
    await expect(
      createStaff(ORG, {
        name: 'X',
        email: 'x@example.com',
        password: 'password123',
        role: 'admin',
      }),
    ).rejects.toThrow('Failed to create staff member');
  });
});

describe('updateStaff', () => {
  it('is a no-op when the patch is empty', async () => {
    const r = await updateStaff(ORG, USER, {});
    expect(r).toEqual({ ok: false, reason: 'no_changes' });
  });

  it('returns not_found when the user is absent in this org', async () => {
    selectQueue.push([]); // current-row load returns nothing
    const r = await updateStaff(ORG, USER, { name: 'X' });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('blocks demoting the last active admin', async () => {
    selectQueue.push([row({ role: 'admin', isActive: true })]); // current
    selectQueue.push([{ value: '0' }]); // zero OTHER active admins
    const r = await updateStaff(ORG, USER, { role: 'technician' });
    expect(r).toEqual({ ok: false, reason: 'last_admin' });
  });

  it('blocks deactivating the last active admin', async () => {
    selectQueue.push([row({ role: 'admin', isActive: true })]);
    selectQueue.push([{ value: '0' }]);
    const r = await updateStaff(ORG, USER, { isActive: false });
    expect(r).toEqual({ ok: false, reason: 'last_admin' });
  });

  it('allows demotion when another active admin remains', async () => {
    selectQueue.push([row({ role: 'admin', isActive: true })]);
    selectQueue.push([{ value: '2' }]); // two other active admins
    updateQueue.push([row({ role: 'technician' })]);
    const r = await updateStaff(ORG, USER, { role: 'technician' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staff.role).toBe('technician');
  });

  it('does not run the last-admin guard for a name-only change', async () => {
    selectQueue.push([row({ role: 'admin', isActive: true })]);
    // No count() row queued — if the guard ran it would read [] → 0 and could
    // wrongly block. A name change must skip the guard entirely.
    updateQueue.push([row({ name: 'Renamed' })]);
    const r = await updateStaff(ORG, USER, { name: 'Renamed' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staff.name).toBe('Renamed');
  });

  it('allows deactivating a technician without touching the admin guard', async () => {
    selectQueue.push([row({ role: 'technician', isActive: true })]);
    updateQueue.push([row({ role: 'technician', isActive: false })]);
    const r = await updateStaff(ORG, USER, { isActive: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staff.isActive).toBe(false);
  });

  it('maps the DB last-admin trigger exception to the last_admin sentinel', async () => {
    // App-level check passes (it sees another active admin) but the write loses
    // a race and the trigger raises — should surface as last_admin, not a throw.
    selectQueue.push([row({ role: 'admin', isActive: true })]); // current
    selectQueue.push([{ value: '1' }]); // app check: one other active admin
    updateQueue.push(
      new Error(
        'last_active_admin: organization X must retain at least one active admin',
      ),
    );
    const r = await updateStaff(ORG, USER, { role: 'technician' });
    expect(r).toEqual({ ok: false, reason: 'last_admin' });
  });

  it('rethrows non-trigger DB errors', async () => {
    selectQueue.push([row({ role: 'technician', isActive: true })]);
    updateQueue.push(new Error('connection reset'));
    await expect(updateStaff(ORG, USER, { name: 'X' })).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('resetStaffPassword', () => {
  it('hashes the new password and never returns it', async () => {
    updateQueue.push([{ id: USER }]);
    const r = await resetStaffPassword(ORG, USER, 'brandnewpass');
    expect(mockHash).toHaveBeenCalledWith('brandnewpass', BCRYPT_COST);
    expect(r).toEqual({ ok: true });
  });

  it('returns not_found when the user is absent', async () => {
    updateQueue.push([]);
    const r = await resetStaffPassword(ORG, USER, 'brandnewpass');
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});
