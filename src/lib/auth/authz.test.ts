import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  isPlatformAdmin,
  isSuperAdmin,
  canAssignRole,
  isPlatformAdminEmail,
  assertMayMutateUser,
  type MutationActor,
} from './authz';

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

describe('isPlatformAdminEmail', () => {
  it('false when the allowlist env is unset, or for null/empty input', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdminEmail('r@x.com')).toBe(false);
    process.env.PLATFORM_ADMIN_EMAILS = 'r@x.com';
    expect(isPlatformAdminEmail(null)).toBe(false);
    expect(isPlatformAdminEmail(undefined)).toBe(false);
    expect(isPlatformAdminEmail('   ')).toBe(false);
  });

  it('matches by trimmed, lowercased email, independent of PLATFORM_ORG_ID', () => {
    process.env.PLATFORM_ADMIN_EMAILS = ' R@x.com , other@y.com ';
    delete process.env.PLATFORM_ORG_ID;
    expect(isPlatformAdminEmail(' r@X.COM ')).toBe(true);
    expect(isPlatformAdminEmail('other@y.com')).toBe(true);
    expect(isPlatformAdminEmail('t@x.com')).toBe(false);
  });
});

describe('assertMayMutateUser', () => {
  const chick: MutationActor = {
    userId: 'chick-id',
    email: 'chick@spears.com',
    role: 'super_admin',
    organizationId: PORG,
  };
  const rchen: MutationActor = {
    userId: 'rchen-id',
    email: 'r@x.com',
    role: 'super_admin',
    organizationId: PORG,
  };

  function configure() {
    process.env.PLATFORM_ADMIN_EMAILS = 'r@x.com';
    process.env.PLATFORM_ORG_ID = PORG;
  }

  it('refuses a non-platform actor on a platform-admin target', () => {
    configure();
    expect(assertMayMutateUser(chick, { email: 'r@x.com' })).toEqual({
      ok: false,
      reason: 'platform_protected',
    });
  });

  it('refuses a non-platform actor setting a platform-admin email (normalized)', () => {
    configure();
    expect(
      assertMayMutateUser(chick, { email: 't@x.com', newEmail: ' R@X.com' }),
    ).toEqual({ ok: false, reason: 'platform_protected' });
  });

  it('refuses a create (newEmail only) of a platform-admin email', () => {
    configure();
    expect(assertMayMutateUser(chick, { newEmail: 'r@x.com' })).toEqual({
      ok: false,
      reason: 'platform_protected',
    });
  });

  it('lets the platform admin mutate their own row', () => {
    configure();
    expect(assertMayMutateUser(rchen, { email: 'r@x.com' })).toEqual({ ok: true });
  });

  it('lets anyone mutate an ordinary user', () => {
    configure();
    expect(assertMayMutateUser(chick, { email: 't@x.com' })).toEqual({ ok: true });
    expect(assertMayMutateUser(chick, {})).toEqual({ ok: true });
  });

  it('refuses an allowlisted email acting from outside the platform org', () => {
    configure();
    const forged: MutationActor = { ...rchen, organizationId: 'attacker-org' };
    expect(assertMayMutateUser(forged, { email: 'r@x.com' })).toEqual({
      ok: false,
      reason: 'platform_protected',
    });
  });

  it('allows everything when PLATFORM_ADMIN_EMAILS is unset', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ORG_ID = PORG;
    expect(assertMayMutateUser(chick, { email: 'r@x.com' })).toEqual({ ok: true });
    expect(
      assertMayMutateUser(chick, { email: 't@x.com', newEmail: 'r@x.com' }),
    ).toEqual({ ok: true });
  });
});
