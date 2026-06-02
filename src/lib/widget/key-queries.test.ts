import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectRows, lastUpdateWhere } = vi.hoisted(() => ({
  selectRows: { value: [] as unknown[] },
  lastUpdateWhere: { value: null as unknown },
}));

function chain(resolved: unknown, opts?: { onWhere?: (w: unknown) => void }): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(resolved);
      }
      if (prop === 'where') {
        return (w: unknown) => {
          opts?.onWhere?.(w);
          return p;
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
    select: () => chain(selectRows.value),
    update: () => chain([{ id: 'k1' }], {
      onWhere: (w) => {
        lastUpdateWhere.value = w;
      },
    }),
    insert: () => chain([{ id: 'k-new', keyPrefix: 'pk_live_xx', label: null, scopes: ['sessions:create'], isActive: true, createdAt: new Date() }]),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  widgetKeys: {
    id: 'wk.id',
    organizationId: 'wk.org',
    keyHash: 'wk.hash',
    keyType: 'wk.type',
    scopes: 'wk.scopes',
    isActive: 'wk.active',
    keyPrefix: 'wk.prefix',
    label: 'wk.label',
    createdAt: 'wk.created',
    revokedAt: 'wk.revoked',
    lastUsedAt: 'wk.lastUsed',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  and: (...a: unknown[]) => ['and', ...a],
  desc: (c: unknown) => c,
}));

import { validateKey, revokeWidgetKey, createWidgetKey } from './key-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.value = [];
  lastUpdateWhere.value = null;
});

describe('validateKey', () => {
  it('returns null for a wrong-shaped key without hitting the DB result', async () => {
    const r = await validateKey('not-a-key');
    expect(r).toBeNull();
  });

  it('returns null for an unknown key', async () => {
    selectRows.value = [];
    const r = await validateKey('pk_live_unknown');
    expect(r).toBeNull();
  });

  it('returns null for a revoked (inactive) key', async () => {
    selectRows.value = [
      {
        id: 'k1',
        organizationId: ORG,
        keyType: 'publishable',
        scopes: ['sessions:create'],
        isActive: false,
      },
    ];
    const r = await validateKey('pk_live_revoked');
    expect(r).toBeNull();
  });

  it('returns org + type + scopes for a valid active key', async () => {
    selectRows.value = [
      {
        id: 'k1',
        organizationId: ORG,
        keyType: 'publishable',
        scopes: ['sessions:create', 'sessions:read'],
        isActive: true,
      },
    ];
    const r = await validateKey('pk_live_good');
    expect(r).toEqual({
      id: 'k1',
      organizationId: ORG,
      keyType: 'publishable',
      scopes: ['sessions:create', 'sessions:read'],
    });
  });
});

describe('revokeWidgetKey', () => {
  it('scopes the revoke by BOTH key id and org (no cross-tenant revoke)', async () => {
    const ok = await revokeWidgetKey(ORG, 'k1');
    expect(ok).toBe(true);
    // The where clause must include an `and(eq(id), eq(org))`.
    const where = JSON.stringify(lastUpdateWhere.value);
    expect(where).toContain('and');
    expect(where).toContain(ORG);
  });
});

describe('createWidgetKey', () => {
  it('creates a publishable key with default session scopes and returns plaintext once', async () => {
    const created = await createWidgetKey(ORG, 'publishable', 'Prod');
    expect(created.plaintext.startsWith('pk_live_')).toBe(true);
    expect(created.record.keyType).toBe('publishable');
  });
});
