import { describe, it, expect } from 'vitest';
import { toQueryString, fromQueryString, filterSyncSearch } from './url-filters';

describe('toQueryString', () => {
  it('omits empty and undefined values', () => {
    expect(toQueryString({ a: '1', b: '', c: undefined })).toBe('?a=1');
  });

  it('returns "" when nothing is set', () => {
    expect(toQueryString({ a: '', b: undefined })).toBe('');
  });

  it('is deterministic (keys sorted)', () => {
    expect(toQueryString({ b: '2', a: '1' })).toBe('?a=1&b=2');
  });

  it('url-encodes values', () => {
    expect(toQueryString({ q: 'a b&c' })).toBe('?q=a+b%26c');
  });
});

describe('fromQueryString', () => {
  it('parses with or without leading ?', () => {
    expect(fromQueryString('?a=1&b=2')).toEqual({ a: '1', b: '2' });
    expect(fromQueryString('a=1&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns {} for empty', () => {
    expect(fromQueryString('')).toEqual({});
  });

  it('decodes values', () => {
    expect(fromQueryString('?q=a+b%26c')).toEqual({ q: 'a b&c' });
  });

  it('round-trips with toQueryString', () => {
    const values = { filter: 'unpaid', sort: 'balance', q: 'acme co' };
    expect(fromQueryString(toQueryString(values))).toEqual(values);
  });
});

describe('filterSyncSearch', () => {
  it('keeps the quick tour params when the filters are at their defaults', () => {
    expect(filterSyncSearch({ status: '', q: '' }, '?from=tour&lesson=requests')).toBe('?from=tour&lesson=requests');
  });

  it('keeps replay=1 next to the tour params', () => {
    expect(filterSyncSearch({}, '?from=tour&lesson=paid&replay=1')).toBe('?from=tour&lesson=paid&replay=1');
  });

  it('merges the tour params with active filters', () => {
    expect(filterSyncSearch({ status: 'pending', q: '' }, '?from=tour&lesson=requests')).toBe(
      '?from=tour&lesson=requests&status=pending',
    );
  });

  it('drops other params that are not filters (stale filters, one-shot deep links)', () => {
    expect(filterSyncSearch({ status: '' }, '?status=pending&request=abc&new=1')).toBe('');
  });

  it('returns the filters alone when no tour params are present', () => {
    expect(filterSyncSearch({ sort: 'oldest' }, '')).toBe('?sort=oldest');
  });

  it('lets a filter of the same name win over a preserved param', () => {
    expect(filterSyncSearch({ from: '2026-01-01' }, '?from=tour')).toBe('?from=2026-01-01');
    expect(filterSyncSearch({ from: '' }, '?from=tour&lesson=requests')).toBe('?lesson=requests');
  });

  it('keeps an empty-valued tour param out of the URL', () => {
    expect(filterSyncSearch({}, '?from=&lesson=')).toBe('');
  });
});
