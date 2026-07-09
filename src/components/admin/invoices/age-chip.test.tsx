import { it, expect } from 'vitest';
import { ageBucket, daysBetween, invoiceAgeDays, overdueByDates } from './age-chip';

it('buckets invoice age into green/amber/red at 30 and 60 days', () => {
  expect(ageBucket(10)).toBe('green');
  expect(ageBucket(30)).toBe('amber');
  expect(ageBucket(59)).toBe('amber');
  expect(ageBucket(60)).toBe('red');
});

it('daysBetween counts whole days elapsed', () => {
  const created = new Date('2026-06-01T00:00:00Z');
  const now = new Date('2026-06-11T00:00:00Z');
  expect(daysBetween(created, now)).toBe(10);
});

const NOW = new Date('2026-07-10T12:00:00Z');

it('invoiceAgeDays prefers issuedAt over createdAt (mirrored invoices)', () => {
  expect(
    invoiceAgeDays({ issuedAt: '2026-05-11T00:00:00Z', createdAt: '2026-07-09T00:00:00Z' }, NOW),
  ).toBe(60);
});

it('invoiceAgeDays falls back to createdAt when issuedAt is null (native invoices)', () => {
  expect(invoiceAgeDays({ issuedAt: null, createdAt: '2026-06-30T12:00:00Z' }, NOW)).toBe(10);
  expect(invoiceAgeDays({ createdAt: '2026-06-30T12:00:00Z' }, NOW)).toBe(10);
});

it('invoiceAgeDays accepts Date objects (detail view shape)', () => {
  expect(
    invoiceAgeDays({ issuedAt: new Date('2026-06-10T12:00:00Z'), createdAt: new Date() }, NOW),
  ).toBe(30);
});

it('overdueByDates uses the due date when present', () => {
  // Due yesterday → overdue.
  expect(
    overdueByDates({ dueDate: '2026-07-09T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' }, NOW),
  ).toBe(true);
  // Due today (not yet a full day past) → not overdue.
  expect(
    overdueByDates({ dueDate: '2026-07-10T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' }, NOW),
  ).toBe(false);
  // Due in the future → not overdue, even for very old invoices.
  expect(
    overdueByDates(
      { dueDate: '2026-08-01T00:00:00Z', issuedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
      NOW,
    ),
  ).toBe(false);
});

it('overdueByDates falls back to age >= 30 days when no due date', () => {
  expect(
    overdueByDates({ dueDate: null, issuedAt: '2026-06-10T12:00:00Z', createdAt: '2026-07-09T00:00:00Z' }, NOW),
  ).toBe(true);
  expect(
    overdueByDates({ dueDate: null, issuedAt: '2026-06-15T00:00:00Z', createdAt: '2026-07-09T00:00:00Z' }, NOW),
  ).toBe(false);
  expect(overdueByDates({ createdAt: '2026-05-01T00:00:00Z' }, NOW)).toBe(true);
});
