import { describe, it, expect, vi, beforeEach } from 'vitest';

// attachment-queries.ts imports "server-only", which throws outside an RSC.
// Make it a no-op in tests (matches the staff-queries / invites test pattern).
vi.mock('server-only', () => ({}));

// Capture the conditions passed into each db builder so we can assert that every
// query is tenant-scoped (withTenant receives the orgId) and matches the right id.
const { selectQueue, updateQueue, captured } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const captured: {
    selectWhere: unknown[];
    updateWhere: unknown[];
    updateSet: unknown[];
    withTenantArgs: unknown[][];
  } = { selectWhere: [], updateWhere: [], updateSet: [], withTenantArgs: [] };

  return { selectQueue, updateQueue, captured };
});

vi.mock('@/lib/db', () => {
  // Chain stubs defined inside the factory; they read from the hoisted queues
  // and record builder args into `captured`.
  const selectChain = (resolved: unknown): unknown => {
    const p: unknown = {
      from: () => p,
      where: (c: unknown) => {
        captured.selectWhere.push(c);
        return p;
      },
      orderBy: () => p,
      limit: () => Promise.resolve(resolved),
      then: (resolve: (v: unknown) => void) => resolve(resolved),
    };
    return p;
  };
  const updateChain = (resolved: unknown): unknown => {
    const p: unknown = {
      set: (s: unknown) => {
        captured.updateSet.push(s);
        return p;
      },
      where: (c: unknown) => {
        captured.updateWhere.push(c);
        return p;
      },
      returning: () => Promise.resolve(resolved),
    };
    return p;
  };
  return {
    db: {
      select: () => selectChain(selectQueue.shift() ?? []),
      update: () => updateChain(updateQueue.shift() ?? []),
    },
  };
});

// withTenant returns a tagged tuple capturing (orgId, ...conditions) so each
// test can prove the org filter was applied with the right id.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => {
    captured.withTenantArgs.push([orgId, ...conditions]);
    return { __tenant: orgId, conditions };
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
  desc: (c: unknown) => c,
}));

vi.mock('@/lib/db/schema', () => ({
  attachments: {
    id: 'a.id',
    organizationId: 'a.org',
    serviceRequestId: 'a.serviceRequestId',
    equipmentId: 'a.equipmentId',
    customerId: 'a.customerId',
    filename: 'a.filename',
    mimeType: 'a.mimeType',
    size: 'a.size',
    storageKey: 'a.storageKey',
    createdAt: 'a.createdAt',
  },
  serviceRequests: { id: 'sr.id', organizationId: 'sr.org' },
  customerEquipment: { id: 'ce.id', organizationId: 'ce.org' },
  customers: { id: 'c.id', organizationId: 'c.org' },
}));

import {
  listAttachmentsForEntity,
  getAttachmentForDownload,
  linkAttachmentToEntity,
  entityBelongsToOrg,
} from './attachment-queries';

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';
const SR_ID = '11111111-1111-1111-1111-111111111111';
const ATT_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  captured.selectWhere.length = 0;
  captured.updateWhere.length = 0;
  captured.updateSet.length = 0;
  captured.withTenantArgs.length = 0;
});

describe('listAttachmentsForEntity', () => {
  it('is tenant-scoped: withTenant gets the orgId plus a serviceRequestId eq', async () => {
    selectQueue.push([{ id: ATT_ID, filename: 'photo.jpg' }]);

    const rows = await listAttachmentsForEntity(ORG_A, {
      serviceRequestId: SR_ID,
    });

    expect(rows).toHaveLength(1);
    expect(captured.withTenantArgs).toHaveLength(1);
    const [orgId, condition] = captured.withTenantArgs[0] as [
      string,
      { __eq: unknown[] },
    ];
    expect(orgId).toBe(ORG_A);
    expect(condition.__eq).toEqual(['a.serviceRequestId', SR_ID]);
  });

  it('returns [] without querying when no entity scope is provided', async () => {
    const rows = await listAttachmentsForEntity(ORG_A, {});
    expect(rows).toEqual([]);
    expect(captured.withTenantArgs).toHaveLength(0);
  });
});

describe('getAttachmentForDownload', () => {
  it('scopes by org and id, returning the record when found', async () => {
    selectQueue.push([{ id: ATT_ID, storageKey: 'org_a_admin_x.pdf' }]);

    const rec = await getAttachmentForDownload(ORG_A, ATT_ID);

    expect(rec).not.toBeNull();
    const [orgId, condition] = captured.withTenantArgs[0] as [
      string,
      { __eq: unknown[] },
    ];
    expect(orgId).toBe(ORG_A);
    expect(condition.__eq).toEqual(['a.id', ATT_ID]);
  });

  it("rejects an attachment from another org (no row -> null), still scoped by the requester's org", async () => {
    // Simulate the row belonging to ORG_B: the tenant-filtered query for ORG_A
    // returns nothing.
    selectQueue.push([]);

    const rec = await getAttachmentForDownload(ORG_A, ATT_ID);

    expect(rec).toBeNull();
    // Critically: the query was scoped to the *requester's* org, not ORG_B.
    expect(captured.withTenantArgs[0][0]).toBe(ORG_A);
    expect(captured.withTenantArgs[0][0]).not.toBe(ORG_B);
  });
});

describe('linkAttachmentToEntity', () => {
  it('scopes the update by org + attachment id and sets only provided keys', async () => {
    updateQueue.push([{ id: ATT_ID }]);

    const ok = await linkAttachmentToEntity(ORG_A, ATT_ID, {
      serviceRequestId: SR_ID,
    });

    expect(ok).toBe(true);
    expect(captured.updateSet[0]).toEqual({ serviceRequestId: SR_ID });
    const [orgId, condition] = captured.withTenantArgs[0] as [
      string,
      { __eq: unknown[] },
    ];
    expect(orgId).toBe(ORG_A);
    expect(condition.__eq).toEqual(['a.id', ATT_ID]);
  });

  it('returns false (no update) when no scope keys are provided', async () => {
    const ok = await linkAttachmentToEntity(ORG_A, ATT_ID, {});
    expect(ok).toBe(false);
    expect(captured.updateSet).toHaveLength(0);
    expect(captured.withTenantArgs).toHaveLength(0);
  });

  it('returns false when the update matches no row (attachment from another org)', async () => {
    updateQueue.push([]);
    const ok = await linkAttachmentToEntity(ORG_A, ATT_ID, {
      customerId: SR_ID,
    });
    expect(ok).toBe(false);
    expect(captured.withTenantArgs[0][0]).toBe(ORG_A);
  });
});

describe('entityBelongsToOrg', () => {
  it('verifies the target service request is in the org', async () => {
    selectQueue.push([{ id: SR_ID }]);
    const ok = await entityBelongsToOrg(ORG_A, { serviceRequestId: SR_ID });
    expect(ok).toBe(true);
    expect(captured.withTenantArgs[0][0]).toBe(ORG_A);
  });

  it('returns false when the entity is not in the org', async () => {
    selectQueue.push([]);
    const ok = await entityBelongsToOrg(ORG_A, { customerId: SR_ID });
    expect(ok).toBe(false);
    expect(captured.withTenantArgs[0][0]).toBe(ORG_A);
  });
});
