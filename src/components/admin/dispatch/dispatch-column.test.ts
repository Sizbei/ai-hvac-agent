import { describe, expect, it } from 'vitest';
import { formatTime } from './dispatch-column';

// The dispatch board is bucketed by BUSINESS (Eastern) day (see
// calendar-time.ts), so a card's arrival time must render in the same zone —
// formatTime previously hardcoded `timeZone: 'UTC'`, which read 4-5h off
// depending on DST (C7).
describe('formatTime', () => {
  it('formats a winter (EST, UTC-5) instant in Eastern wall-clock time', () => {
    // 19:00 UTC in January = 2:00 PM EST.
    expect(formatTime('2026-01-15T19:00:00.000Z')).toBe('2:00 PM');
  });

  it('formats a summer (EDT, UTC-4) instant in Eastern wall-clock time', () => {
    // 18:00 UTC in July = 2:00 PM EDT.
    expect(formatTime('2026-07-15T18:00:00.000Z')).toBe('2:00 PM');
  });

  it('handles the spring-forward DST boundary (2026-03-08, EST -> EDT)', () => {
    // Just before the transition: still EST (UTC-5). 06:59 UTC -> 1:59 AM.
    expect(formatTime('2026-03-08T06:59:00.000Z')).toBe('1:59 AM');
    // At/after the transition: now EDT (UTC-4). 07:00 UTC -> 3:00 AM.
    expect(formatTime('2026-03-08T07:00:00.000Z')).toBe('3:00 AM');
  });

  it('handles the fall-back DST boundary (2026-11-01, EDT -> EST)', () => {
    // Just before the transition: still EDT (UTC-4). 05:59 UTC -> 1:59 AM.
    expect(formatTime('2026-11-01T05:59:00.000Z')).toBe('1:59 AM');
    // At/after the transition: now EST (UTC-5). 06:00 UTC -> 1:00 AM.
    expect(formatTime('2026-11-01T06:00:00.000Z')).toBe('1:00 AM');
  });

  it('returns an em dash for a null arrival time', () => {
    expect(formatTime(null)).toBe('—');
  });

  it('returns an em dash for an invalid ISO string', () => {
    expect(formatTime('not-a-real-date')).toBe('—');
  });
});
