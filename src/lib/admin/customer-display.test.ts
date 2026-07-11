import { describe, it, expect } from 'vitest';
import {
  customerInitials,
  customerCity,
  lastSeenLabel,
  lastSeenTone,
} from './customer-display';

describe('customerInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(customerInitials('David Whittaker')).toBe('DW');
  });
  it('ignores parenthetical suffixes', () => {
    expect(customerInitials('Belk Morristown (TCG)')).toBe('BM');
  });
  it('falls back to the first two characters for a single word', () => {
    expect(customerInitials('Zaxby')).toBe('ZA');
  });
  it('returns "?" for null / empty / punctuation-only', () => {
    expect(customerInitials(null)).toBe('?');
    expect(customerInitials('')).toBe('?');
    expect(customerInitials('()')).toBe('?');
  });
});

describe('customerCity', () => {
  it('pulls the city from a full address', () => {
    expect(
      customerCity('3280 East Andrew Johnson Highway, Greeneville, Tennessee 37745'),
    ).toBe('Greeneville');
  });
  it('returns null for a single-segment or empty address', () => {
    expect(customerCity('603 Sharon Dr')).toBeNull();
    expect(customerCity(null)).toBeNull();
  });
});

describe('lastSeenLabel', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  it('labels today / yesterday / days', () => {
    expect(lastSeenLabel('2026-07-11T09:00:00Z', now)).toBe('today');
    expect(lastSeenLabel('2026-07-10T09:00:00Z', now)).toBe('yesterday');
    expect(lastSeenLabel('2026-07-05T12:00:00Z', now)).toBe('6d ago');
  });
  it('rolls up to months and years', () => {
    expect(lastSeenLabel('2026-05-01T12:00:00Z', now)).toBe('2mo ago');
    expect(lastSeenLabel('2024-01-01T12:00:00Z', now)).toBe('2y ago');
  });
  it('reads future dates as upcoming and null as never', () => {
    expect(lastSeenLabel('2026-08-01T12:00:00Z', now)).toBe('upcoming');
    expect(lastSeenLabel(null, now)).toBe('never');
  });
});

describe('lastSeenTone', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  it('is green when recent or upcoming, amber mid, muted when stale/never', () => {
    expect(lastSeenTone('2026-07-01T12:00:00Z', now)).toBe('#16a34a');
    expect(lastSeenTone('2026-05-15T12:00:00Z', now)).toBe('#d97706');
    expect(lastSeenTone('2025-01-01T12:00:00Z', now)).toBe('#9ca3af');
    expect(lastSeenTone(null, now)).toBe('#9ca3af');
  });
});
