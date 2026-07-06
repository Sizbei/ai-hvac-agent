import { it, expect, describe } from 'vitest';
import { isCollectible, canResend, REMINDER_COOLDOWN_MS } from './invoice-collectible';

const mk = (state: string, total: number, paid: number) => ({ state, totalCents: total, amountPaidCents: paid });

it('open invoice with a balance is collectible', () => {
  expect(isCollectible(mk('open', 5000, 0))).toBe(true);
  expect(isCollectible(mk('open', 5000, 2000))).toBe(true);
});
it('paid / draft / void / refunded are NOT collectible even with a positive balance', () => {
  expect(isCollectible(mk('paid', 5000, 5000))).toBe(false);
  expect(isCollectible(mk('draft', 5000, 0))).toBe(false);   // not sent yet
  expect(isCollectible(mk('void', 5000, 0))).toBe(false);    // voided
  expect(isCollectible(mk('refunded', 5000, 0))).toBe(false); // full refund leaves total>0
});
it('open with zero/negative balance is NOT collectible', () => {
  expect(isCollectible(mk('open', 5000, 5000))).toBe(false);
});

describe('canResend', () => {
  const now = Date.now();

  it('returns true when never reminded (null)', () => {
    expect(canResend(null, now, REMINDER_COOLDOWN_MS)).toBe(true);
  });

  it('returns false when reminded within the cooldown', () => {
    const recentIso = new Date(now - REMINDER_COOLDOWN_MS + 1000).toISOString();
    expect(canResend(recentIso, now, REMINDER_COOLDOWN_MS)).toBe(false);
  });

  it('returns true when reminded exactly at the cooldown boundary', () => {
    const boundaryIso = new Date(now - REMINDER_COOLDOWN_MS).toISOString();
    expect(canResend(boundaryIso, now, REMINDER_COOLDOWN_MS)).toBe(true);
  });

  it('returns true when cooldown has long since passed', () => {
    const oldIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(canResend(oldIso, now, REMINDER_COOLDOWN_MS)).toBe(true);
  });
});
