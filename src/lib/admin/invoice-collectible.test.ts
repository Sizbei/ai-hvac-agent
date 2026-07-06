import { it, expect } from 'vitest';
import { isCollectible } from './invoice-collectible';

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
