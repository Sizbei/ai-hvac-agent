import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue, lastInsertValues, lastConflict } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  lastInsertValues: { value: null as unknown },
  lastConflict: { value: null as unknown },
}));

function chain(resolved: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(resolved);
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

let selectIdx = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectIdx < selectQueue.length ? selectQueue[selectIdx++] : []),
    insert: () => ({
      values: (v: unknown) => {
        lastInsertValues.value = v;
        return {
          onConflictDoUpdate: (c: unknown) => {
            lastConflict.value = c;
            return chain([]);
          },
          returning: () => chain([{ id: 'faq-new' }]),
        };
      },
    }),
    update: () => chain([]),
    delete: () => chain([{ id: 'faq-1' }]),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  organizationSettings: { organizationId: 'os.org' },
  customFaqs: {
    id: 'cf.id',
    organizationId: 'cf.org',
    createdAt: 'cf.created',
    isActive: 'cf.active',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
  desc: (c: unknown) => c,
}));

import {
  getOrgConfig,
  updateOrgConfig,
  getRouterConfig,
} from '@/lib/admin/org-config-queries';
import { DEFAULT_ORG_CONFIG } from '@/lib/admin/org-config-types';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  selectQueue.length = 0;
  selectIdx = 0;
  lastInsertValues.value = null;
  lastConflict.value = null;
});

describe('getOrgConfig', () => {
  it('returns defaults when no settings row exists', async () => {
    selectQueue.push([]); // no row
    const cfg = await getOrgConfig(ORG);
    expect(cfg).toEqual(DEFAULT_ORG_CONFIG);
  });

  it('maps a stored row into resolved config', async () => {
    selectQueue.push([
      {
        companyName: 'Acme HVAC',
        logoUrl: null,
        primaryColor: '#2563eb',
        welcomeMessage: 'Hi!',
        launcherPosition: 'bottom-left',
        disabledIssueTypes: ['installation'],
        disabledServiceTags: ['boiler'],
        businessInfo: { phone: '555-1234' },
      },
    ]);
    const cfg = await getOrgConfig(ORG);
    expect(cfg.companyName).toBe('Acme HVAC');
    expect(cfg.launcherPosition).toBe('bottom-left');
    expect(cfg.disabledIssueTypes).toEqual(['installation']);
    expect(cfg.businessInfo).toEqual({ phone: '555-1234' });
  });

  it('surfaces the conversation-limit columns (null when unset)', async () => {
    selectQueue.push([
      {
        companyName: null,
        logoUrl: null,
        primaryColor: null,
        welcomeMessage: null,
        launcherPosition: 'bottom-right',
        disabledIssueTypes: [],
        disabledServiceTags: [],
        businessInfo: {},
        chatTokenBudget: 25000,
        chatMaxTurns: null,
      },
    ]);
    const cfg = await getOrgConfig(ORG);
    expect(cfg.chatTokenBudget).toBe(25000);
    expect(cfg.chatMaxTurns).toBeNull();
  });
});

describe('updateOrgConfig', () => {
  it('only patches provided fields (partial update) and re-reads', async () => {
    // First select is inside getOrgConfig (the re-read after upsert).
    selectQueue.push([
      {
        companyName: 'Acme HVAC',
        logoUrl: null,
        primaryColor: '#000000',
        welcomeMessage: null,
        launcherPosition: 'bottom-right',
        disabledIssueTypes: [],
        disabledServiceTags: [],
        businessInfo: {},
      },
    ]);

    await updateOrgConfig(ORG, { primaryColor: '#000000' });

    const conflict = lastConflict.value as { set: Record<string, unknown> };
    // The patch must contain ONLY primaryColor (+ updatedAt), not other columns.
    expect(conflict.set).toHaveProperty('primaryColor', '#000000');
    expect(conflict.set).not.toHaveProperty('companyName');
    expect(conflict.set).not.toHaveProperty('businessInfo');
    expect(conflict.set).not.toHaveProperty('chatTokenBudget');
  });

  it('patches the conversation-limit columns, incl. null to reset', async () => {
    selectQueue.push([
      {
        companyName: null,
        logoUrl: null,
        primaryColor: null,
        welcomeMessage: null,
        launcherPosition: 'bottom-right',
        disabledIssueTypes: [],
        disabledServiceTags: [],
        businessInfo: {},
        chatTokenBudget: null,
        chatMaxTurns: null,
      },
    ]);

    await updateOrgConfig(ORG, { chatTokenBudget: 30000, chatMaxTurns: null });

    const conflict = lastConflict.value as { set: Record<string, unknown> };
    // Both present in the patch — 30000, and null (explicit reset). The null
    // must be IN the patch (key present), not dropped as "unprovided".
    expect(conflict.set).toHaveProperty('chatTokenBudget', 30000);
    expect(conflict.set).toHaveProperty('chatMaxTurns', null);
    expect(conflict.set).not.toHaveProperty('primaryColor');
  });
});

describe('getRouterConfig', () => {
  it('assembles disabled services + business info + ACTIVE custom faqs only', async () => {
    // select #1: getOrgConfig row; select #2: listCustomFaqs rows.
    selectQueue.push([
      {
        companyName: null,
        logoUrl: null,
        primaryColor: null,
        welcomeMessage: null,
        launcherPosition: 'bottom-right',
        disabledIssueTypes: ['maintenance'],
        disabledServiceTags: ['boiler'],
        businessInfo: { businessHours: '9-5' },
      },
    ]);
    const now = new Date();
    selectQueue.push([
      {
        id: 'a',
        question: 'q',
        answer: 'active answer',
        triggers: ['plan'],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'b',
        question: 'q2',
        answer: 'inactive answer',
        triggers: ['off'],
        isActive: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const rc = await getRouterConfig(ORG);
    expect(rc.disabledServiceTags).toEqual(['boiler']);
    expect(rc.disabledIssueTypes).toEqual(['maintenance']);
    expect(rc.businessInfo).toEqual({ businessHours: '9-5' });
    // Only the active FAQ is passed to the router.
    expect(rc.customFaqs).toEqual([
      { id: 'a', answer: 'active answer', triggers: ['plan'] },
    ]);
  });
});
