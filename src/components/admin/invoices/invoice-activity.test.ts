import { it, expect, vi } from 'vitest';
// invoice-activity imports daysBetween from age-chip which is 'use client'.
// If any import chain pulls in server-only, stub it here.
vi.mock('server-only', () => ({}));
import { collectionsStats, buildActivity } from './invoice-activity';

const now = new Date('2026-07-06T12:00:00Z');
const created = new Date(now.getTime() - 40 * 24 * 3600 * 1000);
const inv = {
  createdAt: created, state: 'open', totalCents: 5000, amountPaidCents: 0,
  lastReminderSentAt: new Date(now.getTime() - 3 * 24 * 3600 * 1000), payments: [],
} as any;

it('reports days overdue for an open, aged, unpaid invoice', () => {
  expect(collectionsStats(inv, now).daysOverdue).toBe(40);
  expect(collectionsStats(inv, now).lastRemindedRel).toMatch(/3/); // "3d ago"
});
it('daysOverdue is null when paid', () => {
  expect(collectionsStats({ ...inv, state: 'paid', amountPaidCents: 5000 }, now).daysOverdue).toBeNull();
});
it('activity includes a created event and a reminder event, newest first', () => {
  const evs = buildActivity(inv);
  expect(evs.some(e => e.kind === 'created')).toBe(true);
  expect(evs.some(e => e.kind === 'reminder')).toBe(true);
  // newest first: reminder (3d ago) before created (40d ago)
  expect(evs[0].at.getTime()).toBeGreaterThanOrEqual(evs[evs.length - 1].at.getTime());
});

const d = (s: string) => new Date(s);

it('emits one reminder event per history entry, newest included, no lastReminderSentAt double-count', () => {
  const events = buildActivity(
    { createdAt: d('2026-06-01'), lastReminderSentAt: d('2026-07-08'), payments: [] },
    [ { at: d('2026-07-08'), channel: 'sms', status: 'sent' },
      { at: d('2026-07-01'), channel: 'sms', status: 'sent' } ],
  );
  expect(events.filter(e => e.kind === 'reminder')).toHaveLength(2);
});
it('falls back to lastReminderSentAt when history is empty', () => {
  const events = buildActivity(
    { createdAt: d('2026-06-01'), lastReminderSentAt: d('2026-07-08'), payments: [] }, [],
  );
  expect(events.filter(e => e.kind === 'reminder')).toHaveLength(1);
});
