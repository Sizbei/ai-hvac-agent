import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isPlatformAdmin, isSuperAdmin, canAssignRole } from './authz';

const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS;
const ORIGINAL_ORG = process.env.PLATFORM_ORG_ID;
const PORG = 'platform-org-1';

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL;
  if (ORIGINAL_ORG === undefined) delete process.env.PLATFORM_ORG_ID;
  else process.env.PLATFORM_ORG_ID = ORIGINAL_ORG;
});

describe('isPlatformAdmin', () => {
  it('false when the allowlist env is unset (closed by default)', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ORG_ID = PORG;
    expect(isPlatformAdmin({ email: 'a@x.com', organizationId: PORG })).toBe(false);
  });

  it('false when PLATFORM_ORG_ID is unset (fails closed even with an allowlisted email)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    delete process.env.PLATFORM_ORG_ID;
    expect(isPlatformAdmin({ email: 'boss@x.com', organizationId: PORG })).toBe(false);
  });

  it('false for an allowlisted email in the WRONG org (tenant-forgery guard)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    process.env.PLATFORM_ORG_ID = PORG;
    // An attacker who minted boss@x.com in their OWN org is not the platform org.
    expect(isPlatformAdmin({ email: 'boss@x.com', organizationId: 'attacker-org' })).toBe(false);
  });

  it('true only for an allowlisted email in the platform org (case/space-insensitive)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = ' Boss@X.com , other@y.com ';
    process.env.PLATFORM_ORG_ID = PORG;
    expect(isPlatformAdmin({ email: 'boss@x.com', organizationId: PORG })).toBe(true);
    expect(isPlatformAdmin({ email: 'OTHER@Y.COM', organizationId: PORG })).toBe(true);
  });

  it('false for a non-allowlisted email even in the platform org', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    process.env.PLATFORM_ORG_ID = PORG;
    expect(isPlatformAdmin({ email: 'intruder@x.com', organizationId: PORG })).toBe(false);
  });

  it('is independent of in-org role (super_admin is not a platform admin)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'boss@x.com';
    process.env.PLATFORM_ORG_ID = PORG;
    expect(isSuperAdmin({ role: 'super_admin' })).toBe(true);
    expect(isPlatformAdmin({ email: 'super@org.com', organizationId: PORG })).toBe(false);
  });
});

describe('canAssignRole', () => {
  it('never grants super_admin, even to a super_admin actor (defense-in-depth)', () => {
    expect(canAssignRole('super_admin', 'super_admin')).toBe(false);
    expect(canAssignRole('admin', 'super_admin')).toBe(false);
  });

  it('a super_admin may assign admin or technician', () => {
    expect(canAssignRole('super_admin', 'admin')).toBe(true);
    expect(canAssignRole('super_admin', 'technician')).toBe(true);
  });

  it('an admin may only assign technician', () => {
    expect(canAssignRole('admin', 'technician')).toBe(true);
    expect(canAssignRole('admin', 'admin')).toBe(false);
  });
});
