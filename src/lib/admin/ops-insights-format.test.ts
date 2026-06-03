import { describe, it, expect } from 'vitest';
import { formatCents, hourLabel } from './ops-insights-format';

describe('formatCents', () => {
  it('formats whole dollars with no cents', () => {
    expect(formatCents(0)).toBe('$0');
    expect(formatCents(150)).toBe('$2'); // 150c = $1.50 → rounds to $2
    expect(formatCents(100)).toBe('$1');
  });

  it('adds thousands separators', () => {
    expect(formatCents(1_234_500)).toBe('$12,345');
  });

  it('rounds to the nearest dollar', () => {
    expect(formatCents(99)).toBe('$1'); // $0.99 → $1
    expect(formatCents(49)).toBe('$0'); // $0.49 → $0
  });
});

describe('hourLabel', () => {
  it('labels midnight and noon correctly', () => {
    expect(hourLabel(0)).toBe('12a');
    expect(hourLabel(12)).toBe('12p');
  });

  it('labels morning and evening hours', () => {
    expect(hourLabel(9)).toBe('9a');
    expect(hourLabel(13)).toBe('1p');
    expect(hourLabel(23)).toBe('11p');
  });
});
