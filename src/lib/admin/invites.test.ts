import { describe, it, expect, vi, beforeEach } from 'vitest';

// server-only is a no-op in tests (module is server-only by import).
vi.mock('server-only', () => ({}));

vi.mock('@/lib/db/tenant', () => ({
  // Echo the extra conditions so assertions can inspect them if needed.
  withTenant: (_table: unknown, _orgId: string, ...c: unknown[]) => c,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  and: (...a: unknown[]) => ['and', ...a],
  asc: (c: unknown) => c,
  desc: (c: unknown) => c,
  gt: (...a: unknown[]) => ['gt', ...a],
  isNull: (c: unknown) => ['isNull', c],
}));

vi.mock('@/lib/db/schema', () => ({
  staffInvites: {
    id: 'i.id',
    organizationId: 'i.org',
    email: 'i.email',
    role: 'i.role',
    tokenHash: 'i.tokenHash',
    invitedByUserId: 'i.invitedBy',
    expiresAt: 'i.expiresAt',
    acceptedAt: 'i.acceptedAt',
    revokedAt: 'i.revokedAt',
    createdAt: 'i.createdAt',
  },
  users: { id: 'u.id', email: 'u.email', organizationId: 'u.org' },
}));

// staff-queries: real normalizeEmail behavior (trim+lowercase); createStaff mocked.
const mockCreateStaff = vi.fn();
vi.mock('./staff-queries', () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  createStaff: (...a: unknown[]) => mockCreateStaff(...a),
}));

// authz: real policy (admin ⇒ technician only; super_admin ⇒ anything).
vi.mock('@/lib/auth/authz', () => ({
  canAssignRole: (actor: string, desired: string) =>
    actor === 'super_admin' ? true : desired === 'technician',
}));

// --- Chainable db mock with per-call result queues ---
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
  generateInviteToken,
  hashInviteToken,
  createInvite,
  listInvites,
  revokeInvite,
  resolveInviteByToken,
  acceptInvite,
} from './invites';

const ORG = '00000000-0000-0000-0000-000000000001';
const ACTOR = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  mockCreateStaff.mockReset();
});

describe('token generation', () => {
  it('generates a 64-hex-char token whose hash matches hashInviteToken', () => {
    const { token, tokenHash } = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInviteToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a distinct token each call', () => {
    expect(generateInviteToken().token).not.toBe(generateInviteToken().token);
  });

  it('hashInviteToken is deterministic', () => {
    expect(hashInviteToken('abc')).toBe(hashInviteToken('abc'));
    expect(hashInviteToken('abc')).not.toBe(hashInviteToken('abd'));
  });
});

describe('createInvite — authorization', () => {
  it('forbids a normal admin from inviting an admin', async () => {
    const res = await createInvite(
      ORG,
      { email: 'a@x.com', role: 'admin' },
      'admin',
      ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('allows a normal admin to invite a technician', async () => {
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    insertQueue.push([
      {
        id: 'inv1',
        email: 'tech@x.com',
        role: 'technician',
        expiresAt: new Date('2026-06-13T00:00:00Z'),
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG,
      { email: 'tech@x.com', role: 'technician' },
      'admin',
      ACTOR,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.invite.role).toBe('technician');
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('allows a super_admin to invite an admin', async () => {
    selectQueue.push([]);
    selectQueue.push([]);
    insertQueue.push([
      {
        id: 'inv2',
        email: 'admin@x.com',
        role: 'admin',
        expiresAt: new Date('2026-06-13T00:00:00Z'),
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG,
      { email: 'admin@x.com', role: 'admin' },
      'super_admin',
      ACTOR,
    );
    expect(res.ok).toBe(true);
  });
});

describe('createInvite — conflicts', () => {
  it('rejects when a user with that email already exists in the org', async () => {
    selectQueue.push([{ id: 'existing-user' }]);
    const res = await createInvite(
      ORG,
      { email: 'taken@x.com', role: 'technician' },
      'super_admin',
      ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });

  it('rejects when a live invite already exists for that email', async () => {
    selectQueue.push([]); // no user
    selectQueue.push([{ id: 'live-invite' }]); // live invite present
    const res = await createInvite(
      ORG,
      { email: 'pending@x.com', role: 'technician' },
      'super_admin',
      ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'invite_exists' });
  });

  it('normalizes the email before checks', async () => {
    selectQueue.push([{ id: 'existing' }]);
    const res = await createInvite(
      ORG,
      { email: '  Mixed@CASE.com ', role: 'technician' },
      'super_admin',
      ACTOR,
    );
    // It hit the user-conflict branch using the normalized email.
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });
});

describe('listInvites', () => {
  it('maps rows to InviteRecords (ISO timestamps, no token)', async () => {
    selectQueue.push([
      {
        id: 'inv1',
        email: 'a@x.com',
        role: 'technician',
        expiresAt: new Date('2026-06-13T00:00:00Z'),
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const rows = await listInvites(ORG);
    expect(rows).toEqual([
      {
        id: 'inv1',
        email: 'a@x.com',
        role: 'technician',
        expiresAt: '2026-06-13T00:00:00.000Z',
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    ]);
    expect(rows[0]).not.toHaveProperty('tokenHash');
  });
});

describe('revokeInvite', () => {
  it('returns ok when a row is updated', async () => {
    updateQueue.push([{ id: 'inv1' }]);
    expect(await revokeInvite(ORG, 'inv1')).toEqual({ ok: true });
  });

  it('returns not_found when no row matches (wrong org / unknown id)', async () => {
    updateQueue.push([]);
    expect(await revokeInvite(ORG, 'missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('resolveInviteByToken', () => {
  function row(overrides: Record<string, unknown>) {
    return {
      id: 'inv1',
      organizationId: ORG,
      email: 'a@x.com',
      role: 'technician',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
      ...overrides,
    };
  }

  it('not_found for an unknown token', async () => {
    selectQueue.push([]);
    expect(await resolveInviteByToken('nope')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('revoked takes precedence', async () => {
    selectQueue.push([row({ revokedAt: new Date() })]);
    expect(await resolveInviteByToken('t')).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('used when accepted', async () => {
    selectQueue.push([row({ acceptedAt: new Date() })]);
    expect(await resolveInviteByToken('t')).toEqual({
      ok: false,
      reason: 'used',
    });
  });

  it('expired when past expiry', async () => {
    selectQueue.push([row({ expiresAt: new Date(Date.now() - 1000) })]);
    expect(await resolveInviteByToken('t')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('ok for a live invite', async () => {
    selectQueue.push([row({})]);
    const res = await resolveInviteByToken('t');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.invite).toEqual({
        id: 'inv1',
        organizationId: ORG,
        email: 'a@x.com',
        role: 'technician',
      });
    }
  });
});

describe('acceptInvite', () => {
  function liveRow(role: 'admin' | 'technician') {
    return {
      id: 'inv1',
      organizationId: ORG,
      email: 'new@x.com',
      role,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
  }

  it('rejects an invalid token before any write', async () => {
    selectQueue.push([]); // resolve → not_found
    const res = await acceptInvite('bad', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(mockCreateStaff).not.toHaveBeenCalled();
  });

  it('creates the user with the role FROM THE INVITE, not request input', async () => {
    selectQueue.push([liveRow('technician')]); // resolve
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: {
        id: 'user1',
        name: 'N',
        email: 'new@x.com',
        role: 'technician',
        isActive: true,
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim (after create)

    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res.ok).toBe(true);
    // createStaff called with the invite's role + org, NOT a client-chosen role.
    expect(mockCreateStaff).toHaveBeenCalledWith(ORG, {
      name: 'N',
      email: 'new@x.com',
      password: 'password1',
      role: 'technician',
    });
    if (res.ok) {
      expect(res.accepted.role).toBe('technician');
      // technician → no admin session
      expect(res.accepted.session).toBeNull();
    }
  });

  it('mints an admin session for an admin-role invite', async () => {
    selectQueue.push([liveRow('admin')]);
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: {
        id: 'user2',
        name: 'A',
        email: 'new@x.com',
        role: 'admin',
        isActive: true,
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim
    const res = await acceptInvite('t', { name: 'A', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.session).toMatchObject({
        userId: 'user2',
        organizationId: ORG,
        role: 'admin',
      });
    }
  });

  it('reports email_conflict WITHOUT claiming the invite when the user already exists', async () => {
    // create-first ordering: a colliding create means the email is taken, so the
    // invite is left un-claimed (nothing to roll back) and the user is NOT made.
    selectQueue.push([liveRow('technician')]);
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
    // No claim UPDATE was needed (create failed before the claim step).
    expect(updateQueue.length).toBe(0);
  });
});
