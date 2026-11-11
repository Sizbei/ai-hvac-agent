import { describe, it, expect } from 'vitest';
import {
  customerInitials,
  customerCity,
  lastSeenLabel,
  lastSeenTone,
  bookingDateParts,
  customerActivity,
  countLabel,
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
      customerCity('3280 East Millrace Highway, Ashgrove, Tennessee 37745'),
    ).toBe('Ashgrove');
  });
  it('returns null for a single-segment or empty address', () => {
    expect(customerCity('603 Sharon Dr')).toBeNull();
    expect(customerCity(null)).toBeNull();
  });
  it('does not mistake a business name for the city', () => {
    expect(customerCity('Larkin Health Care, 1633 Fernhill Dr')).toBeNull();
    expect(customerCity('P & Q Hair Care, Inc., 1315 Osprey Ave')).toBeNull();
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

describe('bookingDateParts', () => {
  it('uses the business timezone, not UTC', () => {
    // 9:30 pm Eastern on Mar 3 is already Mar 4 in UTC.
    expect(bookingDateParts('2026-03-04T02:30:00.000Z')).toEqual({
      month: 'Mar',
      day: '3',
      year: '2026',
    });
  });
  it('keeps a midday booking on its own day', () => {
    expect(bookingDateParts('2026-07-15T16:00:00.000Z')).toEqual({
      month: 'Jul',
      day: '15',
      year: '2026',
    });
  });
});

describe('customerActivity', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  it('prefers the last completed service', () => {
    expect(
      customerActivity({ lastServiceDate: '2026-11-01T12:00:00Z', lastInvoiceDate: '2026-11-10T12:00:00Z' }, now),
    ).toEqual({ label: 'Last service 10d ago', date: '2026-11-01T12:00:00Z' });
  });
  it('falls back to the last invoice for imported history', () => {
    expect(customerActivity({ lastServiceDate: null, lastInvoiceDate: '2025-07-28 00:00:00+00' }, now)).toEqual({
      label: 'Last invoiced 1y ago',
      date: '2025-07-28 00:00:00+00',
    });
  });
  it('says so when there is nothing', () => {
    expect(customerActivity({ lastServiceDate: null, lastInvoiceDate: null }, now)).toEqual({
      label: 'No service on record',
      date: null,
    });
  });
});

describe('countLabel', () => {
  it('separates thousands and picks the noun', () => {
    expect(countLabel(2660, 'customer')).toBe('2,660 customers');
    expect(countLabel(1, 'invoice')).toBe('1 invoice');
    expect(countLabel(0, 'request')).toBe('0 requests');
    expect(countLabel(3, 'equipment', 'equipment')).toBe('3 equipment');
  });
});
