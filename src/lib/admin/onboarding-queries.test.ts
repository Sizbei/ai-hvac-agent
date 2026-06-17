import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ['eq', ...a],
  and: (...a: unknown[]) => ['and', ...a],
  count: () => ['count'],
}));

vi.mock('@/lib/db/schema', () => ({
  organizationSettings: {
    organizationId: 'os.org',
    companyName: 'os.companyName',
    businessInfo: 'os.businessInfo',
    onboardingState: 'os.onboardingState',
  },
  pricebookItems: {
    organizationId: 'pi.org',
    active: 'pi.active',
  },
  staffInvites: { organizationId: 'i.org' },
  users: { organizationId: 'u.org', isActive: 'u.isActive' },
}));

// Queue-driven select results, consumed in the query order of getOnboardingState:
//   1. settings row, 2. pricebook count, 3. invite count, 4. active-user count.
const selectQueue: unknown[][] = [];
const updateCalls: { set: unknown }[] = [];

function selectResult(): unknown {
  const result = selectQueue.shift() ?? [];
  // Support: .from().where() awaited directly (count queries),
  // .from().where().limit() (settings row), and .from() awaited (rare).
  const whereResult = {
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return {
    where: () => whereResult,
    limit: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => selectResult() }),
    update: () => ({
      set: (set: unknown) => {
        updateCalls.push({ set });
        return { where: () => Promise.resolve([]) };
      },
    }),
  },
}));

import {
  getOnboardingState,
  updateOnboardingFlags,
} from './onboarding-queries';

const ORG = 'org-1';

/** Push the 4 selects getOnboardingState issues, in order. */
function queueState(opts: {
  settings?: Record<string, unknown> | null;
  pricebookCount?: number;
  inviteCount?: number;
  activeUserCount?: number;
}) {
  selectQueue.push(opts.settings === null ? [] : [opts.settings ?? {}]);
  selectQueue.push([{ value: opts.pricebookCount ?? 0 }]);
  selectQueue.push([{ value: opts.inviteCount ?? 0 }]);
  selectQueue.push([{ value: opts.activeUserCount ?? 0 }]);
}

beforeEach(() => {
  selectQueue.length = 0;
  updateCalls.length = 0;
});

describe('getOnboardingState — account_created', () => {
  it('is always done', async () => {
    queueState({});
    const state = await getOnboardingState(ORG);
    const step = state.steps.find((s) => s.id === 'account_created');
    expect(step?.done).toBe(true);
  });
});

describe('getOnboardingState — business_details', () => {
  it('done when businessInfo.phone is non-empty', async () => {
    queueState({ settings: { businessInfo: { phone: '555-1234' } } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'business_details')?.done).toBe(
      true,
    );
  });

  it('done when companyName is non-empty', async () => {
    queueState({ settings: { companyName: 'Acme', businessInfo: {} } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'business_details')?.done).toBe(
      true,
    );
  });

  it('not done when both phone and companyName are empty/missing', async () => {
    queueState({ settings: { companyName: '  ', businessInfo: {} } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'business_details')?.done).toBe(
      false,
    );
  });
});

describe('getOnboardingState — pricebook', () => {
  it('done when ≥1 active pricebook item', async () => {
    queueState({ pricebookCount: 1 });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'pricebook')?.done).toBe(true);
  });

  it('not done when zero active items', async () => {
    queueState({ pricebookCount: 0 });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'pricebook')?.done).toBe(false);
  });
});

describe('getOnboardingState — service_hours', () => {
  it('done when businessInfo.businessHours is present + non-empty', async () => {
    queueState({
      settings: { businessInfo: { businessHours: 'Mon–Fri 8–5' } },
    });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'service_hours')?.done).toBe(true);
  });

  it('not done when businessHours is missing or blank', async () => {
    queueState({ settings: { businessInfo: { businessHours: '' } } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'service_hours')?.done).toBe(false);
  });
});

describe('getOnboardingState — embed_widget', () => {
  it('done when onboardingState.embedViewed is true', async () => {
    queueState({ settings: { businessInfo: {}, onboardingState: { embedViewed: true } } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'embed_widget')?.done).toBe(true);
  });

  it('not done when embedViewed is unset', async () => {
    queueState({ settings: { businessInfo: {} } });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'embed_widget')?.done).toBe(false);
  });
});

describe('getOnboardingState — invite_team', () => {
  it('done when ≥1 staff invite exists', async () => {
    queueState({ inviteCount: 1, activeUserCount: 1 });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'invite_team')?.done).toBe(true);
  });

  it('done when ≥2 active users', async () => {
    queueState({ inviteCount: 0, activeUserCount: 2 });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'invite_team')?.done).toBe(true);
  });

  it('not done with 0 invites and 1 active user (just the owner)', async () => {
    queueState({ inviteCount: 0, activeUserCount: 1 });
    const state = await getOnboardingState(ORG);
    expect(state.steps.find((s) => s.id === 'invite_team')?.done).toBe(false);
  });
});

describe('getOnboardingState — aggregates + dismissed', () => {
  it('reports dismissed and never marks allComplete when steps remain', async () => {
    queueState({ settings: { businessInfo: {}, onboardingState: { dismissed: true } } });
    const state = await getOnboardingState(ORG);
    expect(state.dismissed).toBe(true);
    expect(state.totalCount).toBe(6);
    // Only account_created is done by default.
    expect(state.completedCount).toBe(1);
    expect(state.allComplete).toBe(false);
  });

  it('allComplete when every step is satisfied', async () => {
    queueState({
      settings: {
        companyName: 'Acme',
        businessInfo: { phone: '555', businessHours: '8–5' },
        onboardingState: { embedViewed: true },
      },
      pricebookCount: 3,
      inviteCount: 2,
      activeUserCount: 4,
    });
    const state = await getOnboardingState(ORG);
    expect(state.completedCount).toBe(6);
    expect(state.allComplete).toBe(true);
  });

  it('degrades safely when the settings row is missing', async () => {
    queueState({ settings: null });
    const state = await getOnboardingState(ORG);
    // account_created done; everything else not.
    expect(state.completedCount).toBe(1);
    expect(state.dismissed).toBe(false);
  });
});

describe('updateOnboardingFlags', () => {
  it('merges the update onto the stored flags', async () => {
    // current onboardingState read
    selectQueue.push([{ onboardingState: { embedViewed: true } }]);
    await updateOnboardingFlags(ORG, { dismissed: true });
    expect(updateCalls).toHaveLength(1);
    const set = updateCalls[0]!.set as { onboardingState: unknown };
    expect(set.onboardingState).toEqual({
      embedViewed: true,
      dismissed: true,
    });
  });
});
