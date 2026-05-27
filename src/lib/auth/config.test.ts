import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signToken, verifyToken } from '@/lib/auth/config';
import type { AdminSessionPayload } from '@/lib/auth/types';

const TEST_SECRET = 'a'.repeat(32); // 32 chars minimum

const testPayload: AdminSessionPayload = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  organizationId: '00000000-0000-0000-0000-000000000001',
  email: 'admin@example.com',
  name: 'Test Admin',
  role: 'admin',
};

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalSecret !== undefined) {
    process.env.AUTH_SECRET = originalSecret;
  } else {
    delete process.env.AUTH_SECRET;
  }
});

describe('signToken', () => {
  it('should return a string JWT', async () => {
    const token = await signToken(testPayload);
    expect(typeof token).toBe('string');
    // JWTs have 3 base64url-encoded parts separated by dots
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyToken', () => {
  it('should decode a valid token and return the payload', async () => {
    const token = await signToken(testPayload);
    const result = await verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(testPayload.userId);
    expect(result?.organizationId).toBe(testPayload.organizationId);
    expect(result?.email).toBe(testPayload.email);
    expect(result?.name).toBe(testPayload.name);
    expect(result?.role).toBe('admin');
  });

  it('should preserve all payload fields in a sign -> verify round-trip', async () => {
    const token = await signToken(testPayload);
    const result = await verifyToken(token);
    expect(result).toEqual(testPayload);
  });

  it('should return null for an invalid token', async () => {
    const result = await verifyToken('invalid.token.string');
    expect(result).toBeNull();
  });

  it('should return null for a completely malformed string', async () => {
    const result = await verifyToken('not-a-jwt-at-all');
    expect(result).toBeNull();
  });

  it('should return null for a tampered token', async () => {
    const token = await signToken(testPayload);
    // Replace the entire signature with a different valid base64url string
    const parts = token.split('.');
    const tampered = parts[0] + '.' + parts[1] + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = await verifyToken(tampered);
    expect(result).toBeNull();
  });
});

describe('getAuthSecret (via signToken)', () => {
  it('should throw when AUTH_SECRET is missing', async () => {
    delete process.env.AUTH_SECRET;
    await expect(signToken(testPayload)).rejects.toThrow(
      'AUTH_SECRET environment variable must be set and at least 32 characters',
    );
  });

  it('should throw when AUTH_SECRET is too short', async () => {
    process.env.AUTH_SECRET = 'short';
    await expect(signToken(testPayload)).rejects.toThrow(
      'AUTH_SECRET environment variable must be set and at least 32 characters',
    );
  });

  it('should throw when AUTH_SECRET is empty string', async () => {
    process.env.AUTH_SECRET = '';
    await expect(signToken(testPayload)).rejects.toThrow(
      'AUTH_SECRET environment variable must be set and at least 32 characters',
    );
  });
});
