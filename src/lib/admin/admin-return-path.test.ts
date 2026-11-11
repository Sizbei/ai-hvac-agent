import { describe, it, expect } from 'vitest';
import { safeAdminReturnPath, loginUrlWithReturn } from './admin-fetch';

describe('safeAdminReturnPath', () => {
  it('accepts admin paths with a query', () => {
    expect(safeAdminReturnPath('/admin/invoices?filter=all')).toBe('/admin/invoices?filter=all');
    expect(safeAdminReturnPath('/admin')).toBe('/admin');
  });
  it('rejects anything that could leave the site or loop', () => {
    for (const bad of [
      null, '', 'https://evil.example/admin', '//evil.example/admin', '/admin//evil.example',
      '/administrator', '/tech/jobs', '/admin\\evil', 'javascript:alert(1)',
      '/admin/login', '/admin/login?next=/admin', '/admin/invite/abc', '/admin/x?u=https://evil.example',
    ]) {
      expect(safeAdminReturnPath(bad)).toBeNull();
    }
  });
});

describe('loginUrlWithReturn', () => {
  it('carries a safe path and drops an unsafe one', () => {
    expect(loginUrlWithReturn('/admin/invoices?filter=all')).toBe('/admin/login?next=%2Fadmin%2Finvoices%3Ffilter%3Dall');
    expect(loginUrlWithReturn('/tech/jobs')).toBe('/admin/login');
  });
});
