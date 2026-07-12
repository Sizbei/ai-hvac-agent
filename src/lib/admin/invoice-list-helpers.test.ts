import { describe, it, expect } from 'vitest';
import { pageLabel } from './invoice-list-helpers';

describe('pageLabel', () => {
  it('returns "0 results" when total is 0', () => {
    expect(pageLabel(1, 0, 50)).toBe('0 results');
  });

  it('returns "1–50 of 100" for page 1 of 100 with per=50', () => {
    expect(pageLabel(1, 100, 50)).toBe('1–50 of 100');
  });

  it('returns "51–100 of 100" for page 2 of 100 with per=50', () => {
    expect(pageLabel(2, 100, 50)).toBe('51–100 of 100');
  });

  it('returns "1–30 of 30" for partial last page (30 items, per=50)', () => {
    expect(pageLabel(1, 30, 50)).toBe('1–30 of 30');
  });

  it('returns "1–1 of 1" for single item', () => {
    expect(pageLabel(1, 1, 50)).toBe('1–1 of 1');
  });
});
