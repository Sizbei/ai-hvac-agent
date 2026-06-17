import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGoogleIdentity } from './google-oidc';

vi.mock('server-only', () => ({}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  and: (...a: unknown[]) => ['and', ...a],
  count: () => ['count'],
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/db/schema', () => ({
  organizations: {
    id: 'o.id',
    slug: 'o.slug',
    name: 'o.name',
    ownerEmail: 'o.ownerEmail',
  },
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

vi.mock('@/lib/admin/staff-queries', () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

const seedCommunicationTemplates = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/communication/seeds', () => ({
  seedCommunicationTemplates: (...a: unknown[]) =>
    seedCommunicationTemplates(...a),
}));

// --- db mock: queue-driven select results; record insert/batch calls ---
const selectQueue: unknown[][] = [];
const batchCalls: unknown[][] = [];
const insertedValues: unknown[] = [];
// When set to an Error, the next db.batch() throws it.
let batchError: unknown = null;
// When set, db.batch() throws this ONLY on its first call (slug-retry test).
let batchErrorFirstOnly: unknown = null;

function selectResult(): unknown {
  const result = selectQueue.shift() ?? [];
  return {
    where: () => ({ limit: () => Promise.resolve(result) }),
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => selectResult() }),
    insert: () => ({
      values: (v: unknown) => {
        insertedValues.push(v);
        // Return a statement-like object for batch composition.
        return { __insert: v };
      },
    }),
    batch: (stmts: unknown[]) => {
      batchCalls.push(stmts);
      if (batchErrorFirstOnly && batchCalls.length === 1) {
        return Promise.reject(batchErrorFirstOnly);
      }
      if (batchError) return Promise.reject(batchError);
      return Promise.resolve([]);
    },
  },
}));

import { provisionOrgWithOwner } from './signup';

const IDENTITY: VerifiedGoogleIdentity = {
  sub: 'google-sub-123',
  email: 'Owner@Acme.com',
  emailVerified: true,
  name: 'Pat Owner',
};

beforeEach(() => {
  selectQueue.length = 0;
  batchCalls.length = 0;
  insertedValues.length = 0;
  batchError = null;
  batchErrorFirstOnly = null;
  seedCommunicationTemplates.mockReset();
  seedCommunicationTemplates.mockResolvedValue(undefined);
});

describe('provisionOrgWithOwner — happy path', () => {
  it('creates org + settings + super_admin owner with googleId, ownerEmail NULL', async () => {
    selectQueue.push([]); // B2 global email check: free
    selectQueue.push([{ value: 0 }]); // org count under cap

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });

    expect(res.outcome).toBe('provisioned');
    if (res.outcome !== 'provisioned') return;

    // ONE batch with three statements (org + settings + owner user).
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(3);

    // The org row carries ownerEmail NULL (B1) and the owner is super_admin with
    // the googleId bound + free plan (plan column omitted → NULL = free tier).
    const orgInsert = insertedValues[0] as Record<string, unknown>;
    expect(orgInsert.ownerEmail).toBeNull();
    expect(orgInsert.plan).toBeUndefined(); // NULL plan = free tier
    expect(orgInsert.status).toBe('active');

    const userInsert = insertedValues[2] as Record<string, unknown>;
    expect(userInsert.role).toBe('super_admin');
    expect(userInsert.googleId).toBe('google-sub-123');
    expect(userInsert.email).toBe('owner@acme.com'); // normalized
    expect(userInsert.isActive).toBe(true);

    // Session is ready to mint, super_admin, normalized email.
    expect(res.session.role).toBe('super_admin');
    expect(res.session.email).toBe('owner@acme.com');
    expect(res.session.userId).toBe(res.ownerUserId);
    expect(res.session.organizationId).toBe(res.organizationId);

    // Comms templates seeded best-effort.
    expect(seedCommunicationTemplates).toHaveBeenCalledTimes(1);
  });
});

describe('provisionOrgWithOwner — existing email (B2)', () => {
  it('provisions nothing when the email already belongs to a user (any org)', async () => {
    selectQueue.push([{ id: 'existing-user' }]); // global email check: hit

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });

    expect(res).toEqual({ outcome: 'existing' });
    // No org-count check, no batch, no seed.
    expect(batchCalls).toHaveLength(0);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });
});

describe('provisionOrgWithOwner — org cap', () => {
  it('returns cap_reached when count >= PLATFORM_MAX_ORGS', async () => {
    const prev = process.env.PLATFORM_MAX_ORGS;
    process.env.PLATFORM_MAX_ORGS = '2';
    selectQueue.push([]); // email free
    selectQueue.push([{ value: 2 }]); // at the cap

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });
    process.env.PLATFORM_MAX_ORGS = prev;

    expect(res).toEqual({ outcome: 'cap_reached' });
    expect(batchCalls).toHaveLength(0);
  });
});

describe('provisionOrgWithOwner — slug auto-suffix', () => {
  it('retries the batch with a suffixed slug on a slug unique violation', async () => {
    selectQueue.push([]); // email free
    selectQueue.push([{ value: 0 }]); // under cap
    // First batch fails with the slug violation; the suffixed retry succeeds.
    batchErrorFirstOnly = new Error(
      'duplicate key value violates unique constraint "organizations_slug_unique"',
    );

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });

    expect(res.outcome).toBe('provisioned');
    // Two batch attempts: original + suffixed retry.
    expect(batchCalls).toHaveLength(2);
    // The two org inserts used DIFFERENT slugs.
    const firstSlug = (insertedValues[0] as Record<string, unknown>).slug;
    const retrySlug = (insertedValues[3] as Record<string, unknown>).slug;
    expect(firstSlug).not.toEqual(retrySlug);
  });
});

describe('provisionOrgWithOwner — email taken (cross-org race)', () => {
  it('maps the global users_email_global_unique violation to existing', async () => {
    selectQueue.push([]); // B2 pre-check: email free (racy — passes here)
    selectQueue.push([{ value: 0 }]); // under cap
    // A concurrent same-email signup (different Google sub) provisioned first;
    // the GLOBAL email unique index catches THIS insert.
    batchError = new Error(
      'duplicate key value violates unique constraint "users_email_global_unique"',
    );

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });

    // Race loser provisions NOTHING and is sent to login.
    expect(res).toEqual({ outcome: 'existing' });
    expect(batchCalls).toHaveLength(1);
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });
});

describe('provisionOrgWithOwner — google_id taken (B3)', () => {
  it('maps the global users_google_id_unique violation to google_id_taken', async () => {
    selectQueue.push([]); // email free (brand-new email)
    selectQueue.push([{ value: 0 }]); // under cap
    batchError = new Error(
      'duplicate key value violates unique constraint "users_google_id_unique"',
    );

    const res = await provisionOrgWithOwner({
      businessName: 'Acme HVAC',
      identity: IDENTITY,
    });

    expect(res).toEqual({ outcome: 'google_id_taken' });
    expect(batchCalls).toHaveLength(1);
    // Terminal: no retry, no seed.
    expect(seedCommunicationTemplates).not.toHaveBeenCalled();
  });
});
