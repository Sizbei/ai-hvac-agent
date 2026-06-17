import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  count: () => ['count'],
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/db/schema', () => ({
  organizations: { id: 'o.id', slug: 'o.slug', name: 'o.name', ownerEmail: 'o.ownerEmail' },
  organizationSettings: { organizationId: 'os.org' },
  users: { id: 'u.id', email: 'u.email' },
  staffInvites: {
    id: 'i.id',
    email: 'i.email',
    role: 'i.role',
    expiresAt: 'i.expiresAt',
    createdAt: 'i.createdAt',
  },
}));

vi.mock('./staff-queries', () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

const seedCommunicationTemplates = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/communication/seeds', () => ({
  seedCommunicationTemplates: (...a: unknown[]) =>
    seedCommunicationTemplates(...a),
}));

// --- db mock: queue-driven select results; record insert/batch calls ---
// Each select() shifts ONE result off selectQueue. We support two await shapes:
//   - db.select().from()                 (the org-count query, awaited directly)
//   - db.select().from().where().limit() (the slug / email-taken lookups)
// by returning a thenable from from() that also carries where()/limit() which
// resolve to the SAME shifted result.
const selectQueue: unknown[][] = [];
const returningQueue: unknown[][] = [];
const batchCalls: unknown[][] = [];
const insertedTables: unknown[] = [];
const updateCalls: { table: unknown; set: unknown }[] = [];
// When set to an Error, the next db.batch() throws it (slug-violation test).
let batchError: unknown = null;

function selectResult(): unknown {
  const result = selectQueue.shift() ?? [];
  const thenable: Record<string, unknown> = {
    where: () => ({ limit: () => Promise.resolve(result) }),
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return thenable;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => selectResult() }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return {
        values: () => ({
          returning: () => Promise.resolve(returningQueue.shift() ?? []),
        }),
      };
    },
    update: (table: unknown) => ({
      set: (set: unknown) => {
        updateCalls.push({ table, set });
        return { where: () => Promise.resolve([]) };
      },
    }),
    batch: (stmts: unknown[]) => {
      batchCalls.push(stmts);
      if (batchError) return Promise.reject(batchError);
      return Promise.resolve([]);
    },
  },
}));

import { provisionOrganization, deriveSlug } from './provisioning';

const PLATFORM_ADMIN = 'platform-admin-uuid';

beforeEach(() => {
  selectQueue.length = 0;
  returningQueue.length = 0;
  batchCalls.length = 0;
  insertedTables.length = 0;
  updateCalls.length = 0;
  batchError = null;
  seedCommunicationTemplates.mockReset();
  seedCommunicationTemplates.mockResolvedValue(undefined);
});

describe('deriveSlug', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(deriveSlug('  Acme HVAC Co. ')).toBe('acme-hvac-co');
  });
  it('returns "" for a name with no usable characters', () => {
    expect(deriveSlug('   !!!  ')).toBe('');
  });
});

describe('provisionOrganization — happy path', () => {
  it('creates org + settings in one batch, seeds templates, and creates an invite', async () => {
    selectQueue.push([{ value: 0 }]); // org count under cap
    selectQueue.push([]); // slug free
    selectQueue.push([]); // owner email free
    returningQueue.push([
      {
        id: 'invite-1',
        email: 'owner@acme.com',
        role: 'admin',
        expiresAt: new Date('2026-06-20T00:00:00Z'),
        createdAt: new Date('2026-06-17T00:00:00Z'),
      },
    ]);

    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'Owner@Acme.com',
      createdBy: PLATFORM_ADMIN,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // ONE batch with exactly two statements (organization + settings).
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(2);

    // Comms templates seeded for the new org.
    expect(seedCommunicationTemplates).toHaveBeenCalledTimes(1);
    expect(seedCommunicationTemplates).toHaveBeenCalledWith(
      res.provisioned.organizationId,
    );

    // Invite returned with a one-time plaintext token + admin role.
    expect(res.provisioned.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.provisioned.ownerInvite.role).toBe('admin');
    expect(res.provisioned.ownerInvite.email).toBe('owner@acme.com');
  });
});

describe('provisionOrganization — rejections', () => {
  it('rejects an invalid name (no usable slug)', async () => {
    const res = await provisionOrganization({
      name: '   !!! ',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_name' });
    expect(batchCalls).toHaveLength(0);
  });

  it('rejects a duplicate slug', async () => {
    selectQueue.push([{ value: 0 }]); // org count under cap
    selectQueue.push([{ id: 'existing-org' }]); // slug taken
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    expect(res).toEqual({ ok: false, reason: 'slug_conflict' });
    expect(batchCalls).toHaveLength(0);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });

  it('rejects an owner email already in use', async () => {
    selectQueue.push([{ value: 0 }]); // org count under cap
    selectQueue.push([]); // slug free
    selectQueue.push([{ id: 'existing-user' }]); // email taken
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    expect(res).toEqual({ ok: false, reason: 'owner_email_in_use' });
    expect(batchCalls).toHaveLength(0);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });
});

describe('provisionOrganization — org-count cap (FIX 1)', () => {
  it('rejects with org_limit_reached when count >= PLATFORM_MAX_ORGS', async () => {
    const prev = process.env.PLATFORM_MAX_ORGS;
    process.env.PLATFORM_MAX_ORGS = '2';
    selectQueue.push([{ value: 2 }]); // at the cap
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    process.env.PLATFORM_MAX_ORGS = prev;
    expect(res).toEqual({ ok: false, reason: 'org_limit_reached' });
    // No slug/email lookups, no create, no seed.
    expect(batchCalls).toHaveLength(0);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });

  it('defaults to 100 (NOT unlimited) when PLATFORM_MAX_ORGS is unset', async () => {
    const prev = process.env.PLATFORM_MAX_ORGS;
    delete process.env.PLATFORM_MAX_ORGS;
    selectQueue.push([{ value: 100 }]); // at the default cap
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    process.env.PLATFORM_MAX_ORGS = prev;
    expect(res).toEqual({ ok: false, reason: 'org_limit_reached' });
  });

  it('treats PLATFORM_MAX_ORGS=0 as the default (not unlimited)', async () => {
    const prev = process.env.PLATFORM_MAX_ORGS;
    process.env.PLATFORM_MAX_ORGS = '0';
    selectQueue.push([{ value: 100 }]); // at the fallback default
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    process.env.PLATFORM_MAX_ORGS = prev;
    expect(res).toEqual({ ok: false, reason: 'org_limit_reached' });
  });
});

describe('provisionOrganization — slug unique-violation (FIX 3)', () => {
  it('maps the DB unique-violation on the org insert to slug_conflict (no 500)', async () => {
    selectQueue.push([{ value: 0 }]); // under cap
    selectQueue.push([]); // slug free at pre-check (racy)
    selectQueue.push([]); // owner email free
    // The batched insert loses the race and the DB rejects the duplicate slug.
    batchError = new Error(
      'duplicate key value violates unique constraint "organizations_slug_unique"',
    );
    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });
    expect(res).toEqual({ ok: false, reason: 'slug_conflict' });
    // The batch was attempted; nothing further (no seed, no invite).
    expect(batchCalls).toHaveLength(1);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });
});

describe('provisionOrganization — seed failure tolerated (FIX 4)', () => {
  it('still creates the owner invite when seedCommunicationTemplates throws', async () => {
    selectQueue.push([{ value: 0 }]); // under cap
    selectQueue.push([]); // slug free
    selectQueue.push([]); // owner email free
    seedCommunicationTemplates.mockRejectedValueOnce(new Error('seed boom'));
    returningQueue.push([
      {
        id: 'invite-1',
        email: 'owner@acme.com',
        role: 'admin',
        expiresAt: new Date('2026-06-20T00:00:00Z'),
        createdAt: new Date('2026-06-17T00:00:00Z'),
      },
    ]);

    const res = await provisionOrganization({
      name: 'Acme HVAC',
      ownerEmail: 'owner@acme.com',
      createdBy: PLATFORM_ADMIN,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Org created, seed attempted and failed, invite still issued.
    expect(batchCalls).toHaveLength(1);
    expect(seedCommunicationTemplates).toHaveBeenCalledTimes(1);
    expect(res.provisioned.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.provisioned.ownerInvite.role).toBe('admin');
  });
});
