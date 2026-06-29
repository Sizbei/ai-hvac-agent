import { describe, it, expect, afterEach } from 'vitest';
import { validateEnvVars } from '@/lib/env-validation';

// A complete set of valid required vars, so tests can mutate one at a time.
const VALID = {
  DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require',
  AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  CRON_SECRET: 'cron-secret',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
} as const;

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries({ ...VALID, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('validateEnvVars', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('passes when all required vars are present and well-formed', () => {
    setEnv({});
    expect(() => validateEnvVars()).not.toThrow();
  });

  it('throws listing a missing required var', () => {
    setEnv({ DATABASE_URL: undefined });
    expect(() => validateEnvVars()).toThrow(/DATABASE_URL/);
  });

  it('throws when ENCRYPTION_KEY is present but not 64 chars', () => {
    setEnv({ ENCRYPTION_KEY: 'tooshort' });
    expect(() => validateEnvVars()).toThrow(/ENCRYPTION_KEY must be a 64-character/);
  });

  it('throws when AUTH_SECRET is present but under 32 chars', () => {
    setEnv({ AUTH_SECRET: 'short' });
    expect(() => validateEnvVars()).toThrow(/AUTH_SECRET must be at least 32/);
  });
});
