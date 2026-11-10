import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MutationActor } from '@/lib/auth/authz';

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
  lte: (...a: unknown[]) => ['lte', ...a],
  isNull: (c: unknown) => ['isNull', c],
  count: () => ['count'],
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
  users: {
    id: 'u.id',
    email: 'u.email',
    organizationId: 'u.org',
    role: 'u.role',
    isActive: 'u.isActive',
  },
  organizations: { id: 'o.id', name: 'o.name', ownerEmail: 'o.ownerEmail' },
}));

// staff-queries: real normalizeEmail behavior (trim+lowercase); createStaff and
// claimPasswordlessStaff mocked.
const mockCreateStaff = vi.fn();
const mockClaimPasswordlessStaff = vi.fn();
vi.mock('./staff-queries', () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  createStaff: (...a: unknown[]) => mockCreateStaff(...a),
  claimPasswordlessStaff: (...a: unknown[]) => mockClaimPasswordlessStaff(...a),
}));

// authz: the REAL policy (admin ⇒ technician only; super_admin ⇒ anything;
// platform-admin emails protected), driven by env per test.

// entitlements: seat cap is configurable per test (default high so the seat gate
// is a no-op for the pre-existing happy-path tests).
let mockMaxStaff = 1000;
vi.mock('@/lib/billing/entitlements', () => ({
  getOrgEntitlements: () =>
    Promise.resolve({
      plan: { id: 'test' },
      entitlements: { maxStaff: mockMaxStaff, features: [] },
    }),
}));

// --- Chainable db mock with per-call result queues ---
const selectQueue: unknown[] = [];
const insertQueue: unknown[] = [];
const updateQueue: unknown[] = [];
/** Chained calls (.set/.where/…) on every db.update, for shape assertions. */
const updateLog: unknown[][] = [];

function chain(resolved: unknown, log?: unknown[][]): unknown {
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
      return (...args: unknown[]) => {
        log?.push([prop, ...args]);
        return p;
      };
    },
    apply: () => p,
  });
  return p;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    insert: () => chain(insertQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? [], updateLog),
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
  isOwnerPromotion,
  inviteEmailsLast24h,
  getOwnerInviteTarget,
} from './invites';

const ORG = '00000000-0000-0000-0000-000000000001';
const ACTOR = '11111111-1111-1111-1111-111111111111';
const PORG = '00000000-0000-0000-0000-0000000000ff';
const PLATFORM_EMAIL = 'r@x.com';

const SUPER_ACTOR: MutationActor = {
  userId: ACTOR,
  email: 'boss@org.com',
  role: 'super_admin',
  organizationId: ORG,
};
const ADMIN_ACTOR: MutationActor = { ...SUPER_ACTOR, role: 'admin' };
const PLATFORM_ACTOR: MutationActor = {
  userId: '99999999-9999-9999-9999-999999999999',
  email: PLATFORM_EMAIL,
  role: 'super_admin',
  organizationId: PORG,
};

/** The users row loadInviter reads for ACTOR (an active super_admin). */
function inviterRow(over: Record<string, unknown> = {}) {
  return {
    id: ACTOR,
    email: 'boss@org.com',
    role: 'super_admin',
    organizationId: ORG,
    isActive: true,
    ...over,
  };
}

const ORIGINAL_EMAILS = process.env.PLATFORM_ADMIN_EMAILS;
const ORIGINAL_PORG = process.env.PLATFORM_ORG_ID;
afterEach(() => {
  if (ORIGINAL_EMAILS === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_EMAILS;
  if (ORIGINAL_PORG === undefined) delete process.env.PLATFORM_ORG_ID;
  else process.env.PLATFORM_ORG_ID = ORIGINAL_PORG;
});

beforeEach(() => {
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  updateLog.length = 0;
  mockMaxStaff = 1000;
  process.env.PLATFORM_ADMIN_EMAILS = PLATFORM_EMAIL;
  process.env.PLATFORM_ORG_ID = PORG;
  mockCreateStaff.mockReset();
  mockClaimPasswordlessStaff.mockReset();
  // Default: the existing user is NOT claimable, so pre-existing conflict tests
  // keep their email_conflict outcome.
  mockClaimPasswordlessStaff.mockResolvedValue({ ok: false, reason: 'not_claimable' });
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
      ADMIN_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('allows a normal admin to invite a technician', async () => {
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    selectQueue.push([{ value: 0 }]); // seat count (under cap)
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
      ADMIN_ACTOR,
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
    selectQueue.push([{ value: 0 }]); // seat count (under cap)
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
      SUPER_ACTOR,
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
      SUPER_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });

  it('rejects when a live invite already exists for that email', async () => {
    selectQueue.push([]); // no user
    selectQueue.push([{ id: 'live-invite' }]); // live invite present
    const res = await createInvite(
      ORG,
      { email: 'pending@x.com', role: 'technician' },
      SUPER_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'invite_exists' });
  });

  it('normalizes the email before checks', async () => {
    selectQueue.push([{ id: 'existing' }]);
    const res = await createInvite(
      ORG,
      { email: '  Mixed@CASE.com ', role: 'technician' },
      SUPER_ACTOR,
    );
    // It hit the user-conflict branch using the normalized email.
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });

  it('rejects when the org is at its plan seat limit (entitlement gate)', async () => {
    mockMaxStaff = 2; // cap of 2
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    selectQueue.push([{ value: 2 }]); // 2 active staff == cap
    const res = await createInvite(
      ORG,
      { email: 'new@x.com', role: 'technician' },
      SUPER_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'seat_limit' });
    // No insert should have been attempted.
    expect(insertQueue.length).toBe(0);
  });

  it('allows the invite when active staff is below the seat cap', async () => {
    mockMaxStaff = 5;
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    selectQueue.push([{ value: 4 }]); // under cap
    insertQueue.push([
      {
        id: 'inv9',
        email: 'new@x.com',
        role: 'technician',
        expiresAt: new Date('2026-06-13T00:00:00Z'),
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG,
      { email: 'new@x.com', role: 'technician' },
      SUPER_ACTOR,
    );
    expect(res.ok).toBe(true);
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
      invitedByUserId: ACTOR,
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
        invitedByUserId: ACTOR,
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
      invitedByUserId: ACTOR,
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

  it('acceptInvite returns invalid for an invite to a @demo-hvac.com email', async () => {
    selectQueue.push([{ ...liveRow('admin'), email: 'admin@demo-hvac.com' }]);
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(mockCreateStaff).not.toHaveBeenCalled();
    expect(mockClaimPasswordlessStaff).not.toHaveBeenCalled();
  });

  it('creates the user with the role FROM THE INVITE, not request input', async () => {
    selectQueue.push([liveRow('technician')]); // resolve
    selectQueue.push([inviterRow()]); // loadInviter
    selectQueue.push([{ ownerEmail: null }]); // org has no pending owner
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
    }, SUPER_ACTOR);
    if (res.ok) {
      expect(res.accepted.role).toBe('technician');
      // technician → no admin session
      expect(res.accepted.session).toBeNull();
    }
  });

  it('mints an admin session for an admin-role invite', async () => {
    selectQueue.push([liveRow('admin')]);
    selectQueue.push([inviterRow()]); // loadInviter
    selectQueue.push([{ ownerEmail: null }]); // not a provisioned-owner accept
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
      expect(res.accepted.role).toBe('admin');
      expect(res.accepted.session).toMatchObject({
        userId: 'user2',
        organizationId: ORG,
        role: 'admin',
      });
    }
  });

  it('promotes the provisioned owner to super_admin and clears ownerEmail (FIX 2a)', async () => {
    selectQueue.push([liveRow('admin')]); // resolve: admin invite to new@x.com
    // loadInviter: the PLATFORM admin (the only inviter whose invite promotes)
    selectQueue.push([
      inviterRow({ id: PLATFORM_ACTOR.userId, email: PLATFORM_EMAIL, organizationId: PORG }),
    ]);
    selectQueue.push([{ ownerEmail: 'NEW@x.com' }]); // org owner matches (case-insensitive)
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: {
        id: 'owner-user',
        name: 'Owner',
        email: 'new@x.com',
        role: 'admin',
        isActive: true,
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim
    updateQueue.push([]); // promote user → super_admin
    updateQueue.push([]); // clear org ownerEmail

    const res = await acceptInvite('t', { name: 'Owner', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('super_admin');
      expect(res.accepted.session).toMatchObject({
        userId: 'owner-user',
        organizationId: ORG,
        role: 'super_admin',
      });
    }
  });

  it('does NOT promote a different admin invite for the same org (FIX 2b)', async () => {
    selectQueue.push([liveRow('admin')]); // admin invite to new@x.com
    selectQueue.push([inviterRow()]); // loadInviter
    selectQueue.push([{ ownerEmail: 'someone-else@x.com' }]); // owner is a different email
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: {
        id: 'admin-user',
        name: 'A',
        email: 'new@x.com',
        role: 'admin',
        isActive: true,
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim only — no promotion updates

    const res = await acceptInvite('t', { name: 'A', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('admin');
      expect(res.accepted.session).toMatchObject({ role: 'admin' });
    }
  });

  it('handles a NULL ownerEmail (legacy org) without promotion or crash (FIX 2c)', async () => {
    selectQueue.push([liveRow('admin')]);
    selectQueue.push([inviterRow()]); // loadInviter
    selectQueue.push([{ ownerEmail: null }]); // legacy org: no owner recorded
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: {
        id: 'admin-user',
        name: 'A',
        email: 'new@x.com',
        role: 'admin',
        isActive: true,
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim only

    const res = await acceptInvite('t', { name: 'A', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('admin');
      expect(res.accepted.session).toMatchObject({ role: 'admin' });
    }
  });

  it('reports email_conflict WITHOUT claiming the invite when the user already exists', async () => {
    // create-first ordering: a colliding create means the email is taken, so the
    // invite is left un-claimed (nothing to roll back) and the user is NOT made.
    selectQueue.push([liveRow('technician')]);
    selectQueue.push([inviterRow()]); // loadInviter
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
    // No claim UPDATE was needed (create failed before the claim step).
    expect(updateQueue.length).toBe(0);
  });
});

describe('createInvite — credential-setup for existing password-less users', () => {
  const passwordlessTech = {
    id: 'u9', passwordHash: null, isActive: true, role: 'technician',
  };

  it('allows an invite for an existing ACTIVE PASSWORD-LESS user with the matching role, skipping the seat gate', async () => {
    mockMaxStaff = 0; // seat gate would refuse anything — must be skipped
    selectQueue.push([passwordlessTech]); // existing user (claimable)
    selectQueue.push([]); // no live invite
    insertQueue.push([
      {
        id: 'inv9', email: 'tech@x.com', role: 'technician',
        expiresAt: new Date('2026-07-14T00:00:00Z'),
        createdAt: new Date('2026-07-11T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG, { email: 'tech@x.com', role: 'technician' }, ADMIN_ACTOR,
    );
    expect(res.ok).toBe(true);
  });

  it('still refuses when the existing user already has a password', async () => {
    selectQueue.push([{ ...passwordlessTech, passwordHash: 'x' }]);
    const res = await createInvite(
      ORG, { email: 'tech@x.com', role: 'technician' }, ADMIN_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });

  it('still refuses on role mismatch or inactive user', async () => {
    selectQueue.push([{ ...passwordlessTech, role: 'admin' }]);
    expect(
      await createInvite(ORG, { email: 't@x.com', role: 'technician' }, SUPER_ACTOR),
    ).toEqual({ ok: false, reason: 'email_conflict' });
    selectQueue.push([{ ...passwordlessTech, isActive: false }]);
    expect(
      await createInvite(ORG, { email: 't@x.com', role: 'technician' }, SUPER_ACTOR),
    ).toEqual({ ok: false, reason: 'email_conflict' });
  });
});

describe('acceptInvite — claims an existing password-less user', () => {
  function liveTechRow() {
    return {
      id: 'inv1', organizationId: ORG, email: 'tech@x.com', role: 'technician',
      invitedByUserId: ACTOR,
      expiresAt: new Date(Date.now() + 60_000), acceptedAt: null, revokedAt: null,
    };
  }

  it('sets the password on the existing user when createStaff hits email_conflict', async () => {
    selectQueue.push([liveTechRow()]); // resolve token
    selectQueue.push([inviterRow()]); // loadInviter
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    mockClaimPasswordlessStaff.mockResolvedValue({
      ok: true,
      staff: { id: 'u9', email: 'tech@x.com', name: 'Existing Tech' },
    });
    selectQueue.push([{ ownerEmail: null }]); // org owner check (no promotion)
    const res = await acceptInvite('t', { name: 'Ignored', password: 'password1' });
    expect(mockClaimPasswordlessStaff).toHaveBeenCalledWith(ORG, {
      email: 'tech@x.com', role: 'technician', password: 'password1',
    }, SUPER_ACTOR);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.userId).toBe('u9');
      expect(res.accepted.role).toBe('technician');
      expect(res.accepted.session).toBeNull(); // technician: no admin session
      expect(res.accepted.name).toBe('Existing Tech'); // keeps THEIR name
    }
  });

  it('keeps email_conflict when the existing user is not claimable', async () => {
    selectQueue.push([liveTechRow()]);
    selectQueue.push([inviterRow()]); // loadInviter
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'email_conflict' });
  });
});

describe('platform-admin protection and the inviter as actor', () => {
  function liveRow(role: 'admin' | 'technician', email = 'new@x.com') {
    return {
      id: 'inv1',
      organizationId: ORG,
      email,
      role,
      invitedByUserId: ACTOR,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
  }

  it('createInvite refuses a platform-admin email', async () => {
    const res = await createInvite(
      ORG,
      { email: ' R@X.com ', role: 'technician' },
      SUPER_ACTOR,
    );
    expect(res).toEqual({ ok: false, reason: 'platform_protected' });
    expect(insertQueue.length).toBe(0);
  });

  it('createInvite records the actor as the inviter', async () => {
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    selectQueue.push([{ value: 0 }]); // seat count
    insertQueue.push([
      {
        id: 'inv1',
        email: 'new@x.com',
        role: 'technician',
        expiresAt: new Date('2026-06-13T00:00:00Z'),
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG,
      { email: 'new@x.com', role: 'technician' },
      PLATFORM_ACTOR,
    );
    expect(res.ok).toBe(true);
  });

  it('acceptInvite returns invalid when the inviter is inactive or no longer admin-tier', async () => {
    selectQueue.push([liveRow('technician')]);
    selectQueue.push([inviterRow({ isActive: false })]);
    expect(
      await acceptInvite('t', { name: 'N', password: 'password1' }),
    ).toEqual({ ok: false, reason: 'invalid' });

    selectQueue.push([liveRow('technician')]);
    selectQueue.push([inviterRow({ role: 'technician' })]);
    expect(
      await acceptInvite('t', { name: 'N', password: 'password1' }),
    ).toEqual({ ok: false, reason: 'invalid' });

    selectQueue.push([liveRow('technician')]);
    selectQueue.push([]); // inviter row gone
    expect(
      await acceptInvite('t', { name: 'N', password: 'password1' }),
    ).toEqual({ ok: false, reason: 'invalid' });

    expect(mockCreateStaff).not.toHaveBeenCalled();
    expect(mockClaimPasswordlessStaff).not.toHaveBeenCalled();
  });

  it('acceptInvite returns invalid for an admin invite whose inviter was demoted from super_admin to admin', async () => {
    selectQueue.push([liveRow('admin')]);
    selectQueue.push([inviterRow({ role: 'admin' })]);
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(mockCreateStaff).not.toHaveBeenCalled();
  });

  it('acceptInvite passes the inviter (loaded from any org) as the actor', async () => {
    selectQueue.push([liveRow('admin')]);
    selectQueue.push([
      inviterRow({
        id: PLATFORM_ACTOR.userId,
        email: PLATFORM_EMAIL,
        organizationId: PORG,
      }),
    ]);
    selectQueue.push([{ ownerEmail: null }]);
    mockCreateStaff.mockResolvedValue({
      ok: true,
      staff: { id: 'u1', name: 'N', email: 'new@x.com', role: 'admin' },
    });
    updateQueue.push([{ id: 'inv1' }]);
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res.ok).toBe(true);
    expect(mockCreateStaff).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ email: 'new@x.com', role: 'admin' }),
      PLATFORM_ACTOR,
    );
  });

  it('acceptInvite returns invalid when createStaff refuses (platform-protected email)', async () => {
    selectQueue.push([liveRow('admin', PLATFORM_EMAIL)]);
    selectQueue.push([inviterRow()]);
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'platform_protected' });
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    // A refusal never falls through to claiming the existing row.
    expect(mockClaimPasswordlessStaff).not.toHaveBeenCalled();
    expect(updateQueue.length).toBe(0);
  });

  it('acceptInvite returns invalid when the claim of an existing row is refused', async () => {
    selectQueue.push([liveRow('admin', PLATFORM_EMAIL)]);
    selectQueue.push([inviterRow()]);
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    mockClaimPasswordlessStaff.mockResolvedValue({ ok: false, reason: 'platform_protected' });
    const res = await acceptInvite('t', { name: 'N', password: 'password1' });
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('isOwnerPromotion', () => {
  const ok = {
    ownerEmail: 'c@s.com',
    inviteEmail: 'C@s.com',
    inviteRole: 'admin' as const,
    inviter: PLATFORM_ACTOR as MutationActor | null,
  };

  it('is true for an admin invite to the owner email from a platform admin', () => {
    expect(isOwnerPromotion(ok)).toBe(true);
    expect(isOwnerPromotion({ ...ok, ownerEmail: ' c@S.com ' })).toBe(true);
  });

  it('is false for a technician invite', () => {
    expect(isOwnerPromotion({ ...ok, inviteRole: 'technician' })).toBe(false);
  });

  it('is false when the inviter is an org super_admin, not a platform admin', () => {
    expect(isOwnerPromotion({ ...ok, inviter: SUPER_ACTOR })).toBe(false);
  });

  it('is false for a platform-allowlisted email outside the platform org', () => {
    expect(
      isOwnerPromotion({ ...ok, inviter: { ...PLATFORM_ACTOR, organizationId: ORG } }),
    ).toBe(false);
  });

  it('is false without an inviter', () => {
    expect(isOwnerPromotion({ ...ok, inviter: null })).toBe(false);
  });

  it('is false without an owner email, or for a different email', () => {
    expect(isOwnerPromotion({ ...ok, ownerEmail: null })).toBe(false);
    expect(isOwnerPromotion({ ...ok, ownerEmail: '' })).toBe(false);
    expect(isOwnerPromotion({ ...ok, inviteEmail: 'other@s.com' })).toBe(false);
  });

  it('is false when platform admin is not configured (fail closed)', () => {
    delete process.env.PLATFORM_ORG_ID;
    expect(isOwnerPromotion(ok)).toBe(false);
  });
});

describe('acceptInvite — owner promotion is tightened (spec P2)', () => {
  function ownerInviteRow(role: 'admin' | 'technician', invitedByUserId: string) {
    return {
      id: 'inv1',
      organizationId: ORG,
      email: 'owner@x.com',
      role,
      invitedByUserId,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      revokedAt: null,
    };
  }
  const platformInviterRow = () =>
    inviterRow({ id: PLATFORM_ACTOR.userId, email: PLATFORM_EMAIL, organizationId: PORG });

  function staff(role: 'admin' | 'technician') {
    return {
      ok: true,
      staff: { id: 'owner-user', name: 'O', email: 'owner@x.com', role, isActive: true },
    };
  }

  it('does NOT promote an admin invite to the owner email from an org super_admin', async () => {
    selectQueue.push([ownerInviteRow('admin', ACTOR)]);
    selectQueue.push([inviterRow()]); // org super_admin, not platform
    selectQueue.push([{ ownerEmail: 'owner@x.com' }]);
    mockCreateStaff.mockResolvedValue(staff('admin'));
    updateQueue.push([{ id: 'inv1' }]); // claim only

    const res = await acceptInvite('t', { name: 'O', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('admin');
      expect(res.accepted.session).toMatchObject({ role: 'admin' });
    }
    expect(updateQueue.length).toBe(0); // no extra updates were consumed
  });

  it('does NOT promote a technician invite to the owner email, even from a platform admin', async () => {
    selectQueue.push([ownerInviteRow('technician', PLATFORM_ACTOR.userId)]);
    selectQueue.push([platformInviterRow()]);
    selectQueue.push([{ ownerEmail: 'owner@x.com' }]);
    mockCreateStaff.mockResolvedValue(staff('technician'));
    updateQueue.push([{ id: 'inv1' }]);

    const res = await acceptInvite('t', { name: 'O', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('technician');
      expect(res.accepted.session).toBeNull();
    }
  });

  it('promotes the credential-setup owner (existing password-less admin) from a platform invite', async () => {
    selectQueue.push([ownerInviteRow('admin', PLATFORM_ACTOR.userId)]);
    selectQueue.push([platformInviterRow()]);
    selectQueue.push([{ ownerEmail: 'OWNER@x.com' }]);
    mockCreateStaff.mockResolvedValue({ ok: false, reason: 'email_conflict' });
    mockClaimPasswordlessStaff.mockResolvedValue({
      ok: true,
      staff: { id: 'chick', name: 'Chick', email: 'owner@x.com' },
    });
    updateQueue.push([{ id: 'inv1' }]); // claim
    updateQueue.push([]); // promote
    updateQueue.push([]); // clear ownerEmail

    const res = await acceptInvite('t', { name: 'ignored', password: 'password1' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accepted.role).toBe('super_admin');
      expect(res.accepted.session).toMatchObject({ userId: 'chick', role: 'super_admin' });
    }
    expect(mockClaimPasswordlessStaff).toHaveBeenCalledWith(
      ORG,
      { email: 'owner@x.com', role: 'admin', password: 'password1' },
      PLATFORM_ACTOR,
    );
  });
});

describe('inviteEmailsLast24h', () => {
  it('returns the count of invites created in the org in the last 24 h', async () => {
    selectQueue.push([{ value: 7 }]);
    expect(await inviteEmailsLast24h(ORG)).toBe(7);
  });

  it('returns 0 when there are none', async () => {
    selectQueue.push([]);
    expect(await inviteEmailsLast24h(ORG)).toBe(0);
  });
});

describe('getOwnerInviteTarget', () => {
  it('returns the org name and owner email', async () => {
    selectQueue.push([{ name: 'Spears', ownerEmail: 'c@s.com' }]);
    expect(await getOwnerInviteTarget(ORG)).toEqual({ name: 'Spears', ownerEmail: 'c@s.com' });
  });

  it('returns null for an unknown org', async () => {
    selectQueue.push([]);
    expect(await getOwnerInviteTarget(ORG)).toBeNull();
  });

  it('keeps a NULL owner email as null', async () => {
    selectQueue.push([{ name: 'Spears', ownerEmail: null }]);
    expect(await getOwnerInviteTarget(ORG)).toEqual({ name: 'Spears', ownerEmail: null });
  });
});

describe('createInvite — re-invite after expiry', () => {
  it('revokes the expired, unaccepted invite for the same email right before inserting', async () => {
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no LIVE invite (the old one has expired)
    selectQueue.push([{ value: 0 }]); // seat count
    insertQueue.push([
      {
        id: 'inv2',
        email: 'owner@x.com',
        role: 'admin',
        expiresAt: new Date('2026-11-14T00:00:00Z'),
        createdAt: new Date('2026-11-11T00:00:00Z'),
      },
    ]);
    const res = await createInvite(
      ORG,
      { email: ' Owner@X.com ', role: 'admin' },
      PLATFORM_ACTOR,
    );
    expect(res.ok).toBe(true);

    const set = updateLog.find((c) => c[0] === 'set');
    expect(set?.[1]).toEqual({ revokedAt: expect.any(Date) });
    const where = updateLog.find((c) => c[0] === 'where')?.[1] as unknown[];
    // Scoped to the org (withTenant mock echoes the conditions), this email,
    // still pending, and already expired — a live invite is never touched.
    expect(where).toEqual([
      ['eq', 'i.email', 'owner@x.com'],
      ['isNull', 'i.acceptedAt'],
      ['isNull', 'i.revokedAt'],
      ['lte', 'i.expiresAt', expect.any(Date)],
    ]);
  });

  it('keeps invite_exists for a still-live pending invite, revoking nothing', async () => {
    selectQueue.push([]); // no existing user
    selectQueue.push([{ id: 'live' }]); // live invite
    const res = await createInvite(ORG, { email: 'owner@x.com', role: 'admin' }, PLATFORM_ACTOR);
    expect(res).toEqual({ ok: false, reason: 'invite_exists' });
    expect(updateLog).toEqual([]);
  });

  it('revokes nothing when the invite is refused for seats', async () => {
    mockMaxStaff = 1;
    selectQueue.push([]); // no existing user
    selectQueue.push([]); // no live invite
    selectQueue.push([{ value: 1 }]); // at cap
    const res = await createInvite(ORG, { email: 'n@x.com', role: 'technician' }, SUPER_ACTOR);
    expect(res).toEqual({ ok: false, reason: 'seat_limit' });
    expect(updateLog).toEqual([]);
  });
});
