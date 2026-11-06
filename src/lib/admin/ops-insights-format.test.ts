import { describe, it, expect } from 'vitest';
import { formatCents, hourLabel, timeZoneLabel, sortByUrgency, peakHour } from './ops-insights-format';

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

describe('timeZoneLabel', () => {
  it('names the zone in words', () => {
    expect(timeZoneLabel('America/New_York')).toBe('Eastern Time');
    expect(timeZoneLabel('America/Chicago')).toBe('Central Time');
  });
  it('falls back to the id for an unknown zone', () => {
    expect(timeZoneLabel('Not/AZone')).toBe('Not/AZone');
  });
});

describe('sortByUrgency', () => {
  it('orders emergency, high, medium, low, then anything else', () => {
    const rows = [{ key: 'medium' }, { key: 'low' }, { key: 'weird' }, { key: 'high' }, { key: 'emergency' }];
    expect(sortByUrgency(rows).map((r) => r.key)).toEqual(['emergency', 'high', 'medium', 'low', 'weird']);
  });
});

describe('peakHour', () => {
  it('picks the earliest busiest hour and null for no data', () => {
    expect(peakHour([{ hour: 3, count: 2 }, { hour: 9, count: 5 }, { hour: 14, count: 5 }])).toBe(9);
    expect(peakHour([{ hour: 0, count: 0 }])).toBeNull();
  });
});
