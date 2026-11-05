import { describe, it, expect } from 'vitest';
import { shortIssuedDate } from './invoice-dates';

const NOW = new Date('2026-11-05T12:00:00Z');

describe('shortIssuedDate', () => {
  it('omits the year inside the current year', () => {
    expect(shortIssuedDate('2026-06-01T00:00:00Z', NOW)).toBe('Jun 1');
  });
  it('adds the year for an older invoice', () => {
    expect(shortIssuedDate('2025-06-01T00:00:00Z', NOW)).toBe('Jun 1, 2025');
  });
});
