import { describe, it, expect } from 'vitest';
import { toQueryString, fromQueryString } from './url-filters';

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
