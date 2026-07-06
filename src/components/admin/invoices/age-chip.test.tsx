import { it, expect } from 'vitest';
import { ageBucket, daysBetween } from './age-chip';

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
