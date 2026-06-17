import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isPlatformAdmin, isSuperAdmin } from './authz';

const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL;
});

describe('isPlatformAdmin', () => {
  it('false when the allowlist env is unset (closed by default)', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin({ email: 'a@x.com' })).toBe(false);
  });

  it('false when the allowlist is empty', () => {
    process.env.PLATFORM_ADMIN_EMAILS = '';
    expect(isPlatformAdmin({ email: 'a@x.com' })).toBe(false);
  });

  it('true for an allowlisted email (case/space-insensitive)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = ' Boss@X.com , other@y.com ';
    expect(isPlatformAdmin({ email: 'boss@x.com' })).toBe(true);
    expect(isPlatformAdmin({ email: 'OTHER@Y.COM' })).toBe(true);
  });

  it('false for a non-allowlisted email', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    expect(isPlatformAdmin({ email: 'intruder@x.com' })).toBe(false);
  });

  it('is independent of in-org role (super_admin is not a platform admin)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    // A super_admin whose email is not allowlisted is NOT a platform admin.
    expect(isSuperAdmin({ role: 'super_admin' })).toBe(true);
    expect(isPlatformAdmin({ email: 'super@org.com' })).toBe(false);
  });
});
