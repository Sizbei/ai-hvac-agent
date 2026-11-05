import { describe, it, expect } from 'vitest';
import { defaultTaxBps, draftOptionTotals, draftQuantity } from './estimate-draft';

const items = new Map([
  ['pump', { priceCents: 18500, memberPriceCents: 16000 }],
  ['tune', { priceCents: 12900, memberPriceCents: null }],
]);
const line = (p: Partial<Parameters<typeof draftOptionTotals>[0][number]>) => ({
  name: '', quantity: '1', unitPrice: '', pricebookItemId: null, useMemberPrice: false, ...p,
});

describe('draftOptionTotals', () => {
  it('prices catalog and manual lines and applies tax', () => {
    const t = draftOptionTotals(
      [line({ pricebookItemId: 'pump', quantity: '2' }), line({ name: 'Labor', unitPrice: '75.50' })],
      items,
      950, // 9.5%
    );
    expect(t.subtotalCents).toBe(2 * 18500 + 7550);
    expect(t.taxCents).toBe(Math.round(44550 * 0.095));
    expect(t.totalCents).toBe(t.subtotalCents + t.taxCents);
  });

  it('honours the member price toggle, falling back when there is none', () => {
    expect(draftOptionTotals([line({ pricebookItemId: 'pump', useMemberPrice: true })], items, 0).totalCents).toBe(16000);
    expect(draftOptionTotals([line({ pricebookItemId: 'tune', useMemberPrice: true })], items, 0).totalCents).toBe(12900);
  });

  it('skips blank manual lines and unknown catalog ids', () => {
    expect(draftOptionTotals([line({}), line({ pricebookItemId: 'gone' })], items, 0).totalCents).toBe(0);
  });
});

describe('draftQuantity / defaultTaxBps', () => {
  it('quantity is a whole number of at least 1', () => {
    expect(draftQuantity('3')).toBe(3);
    expect(draftQuantity('')).toBe(1);
    expect(draftQuantity('0')).toBe(1);
  });
  it('uses the active default rate, else 0', () => {
    expect(defaultTaxBps([{ rateBps: 700, isDefault: false, active: true }, { rateBps: 950, isDefault: true, active: true }])).toBe(950);
    expect(defaultTaxBps([{ rateBps: 950, isDefault: true, active: false }])).toBe(0);
    expect(defaultTaxBps([])).toBe(0);
  });
});
