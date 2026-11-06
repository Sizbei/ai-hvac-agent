import { describe, it, expect } from 'vitest';
import { markupFromPrice, markupInputAfterPriceEdit, priceFromMarkup } from './pricebook-markup';

describe('priceFromMarkup', () => {
  it('prices cost plus markup', () => {
    expect(priceFromMarkup(6000, 200)).toBe(18000);
    expect(priceFromMarkup(6000, 0)).toBe(6000);
    expect(priceFromMarkup(3333, 33)).toBe(4433);
  });
  it('gives nothing without a cost', () => {
    expect(priceFromMarkup(0, 200)).toBeNull();
    expect(priceFromMarkup(Number.NaN, 200)).toBeNull();
    expect(priceFromMarkup(6000, -5)).toBeNull();
  });
});

describe('markupFromPrice', () => {
  it('derives the whole-percent markup', () => {
    expect(markupFromPrice(18500, 6000)).toBe(208);
    expect(markupFromPrice(18000, 6000)).toBe(200);
  });
  it('is 0 without cost or at/below cost', () => {
    expect(markupFromPrice(18500, 0)).toBe(0);
    expect(markupFromPrice(5000, 6000)).toBe(0);
  });
});

describe('markupInputAfterPriceEdit', () => {
  it('recomputes the markup when the price changes (cost 20, price 55 → 175)', () => {
    expect(markupInputAfterPriceEdit(5500, 2000)).toBe('175');
  });
  it('clears the markup without a usable cost or price', () => {
    expect(markupInputAfterPriceEdit(5500, 0)).toBe('');
    expect(markupInputAfterPriceEdit(5500, null)).toBe('');
    expect(markupInputAfterPriceEdit(null, 2000)).toBe('');
    expect(markupInputAfterPriceEdit(1500, 2000)).toBe('');
  });
});
