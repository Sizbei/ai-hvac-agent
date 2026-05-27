import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encrypt, decrypt, encryptFields, decryptFields } from '@/lib/crypto';

const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
const originalKey = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

describe('encrypt / decrypt', () => {
  it('should round-trip encrypt then decrypt to original plaintext', () => {
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext);
    const result = decrypt(ciphertext);
    expect(result).toBe(plaintext);
  });

  it('should produce different ciphertext each call due to random IV', () => {
    const plaintext = 'same input';
    const ct1 = encrypt(plaintext);
    const ct2 = encrypt(plaintext);
    expect(ct1).not.toBe(ct2);
    // Both should decrypt to the same value
    expect(decrypt(ct1)).toBe(plaintext);
    expect(decrypt(ct2)).toBe(plaintext);
  });

  it('should throw on tampered ciphertext', () => {
    const ciphertext = encrypt('test data');
    // Flip a character in the middle of the base64 string
    const tampered = ciphertext.slice(0, 10) + 'X' + ciphertext.slice(11);
    expect(() => decrypt(tampered)).toThrow();
  });

  it('should handle empty string encrypt and decrypt', () => {
    const ciphertext = encrypt('');
    const result = decrypt(ciphertext);
    expect(result).toBe('');
  });

  it('should round-trip unicode characters', () => {
    const unicode = 'Hello! Prices are 100 EUR. Data: éàüñö';
    const ciphertext = encrypt(unicode);
    expect(decrypt(ciphertext)).toBe(unicode);
  });

  it('should round-trip emoji characters', () => {
    const emoji = 'Test with emojis: 😀🏠🔧';
    const ciphertext = encrypt(emoji);
    expect(decrypt(ciphertext)).toBe(emoji);
  });

  it('should throw descriptive error when ciphertext is too short', () => {
    const shortCiphertext = Buffer.from('short').toString('base64');
    expect(() => decrypt(shortCiphertext)).toThrow('Invalid ciphertext: too short');
  });

  it('should throw on completely invalid base64 ciphertext', () => {
    // Even though Buffer.from handles bad base64 gracefully, the length check or auth tag will fail
    expect(() => decrypt('not-valid-at-all')).toThrow();
  });
});

describe('encrypt / decrypt - key validation', () => {
  it('should throw when ENCRYPTION_KEY is missing', () => {
    const savedKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
    process.env.ENCRYPTION_KEY = savedKey;
  });

  it('should throw when ENCRYPTION_KEY has wrong length', () => {
    const savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
    process.env.ENCRYPTION_KEY = savedKey;
  });

  it('should throw when ENCRYPTION_KEY is empty string', () => {
    const savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = '';
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be a 64-character hex string');
    process.env.ENCRYPTION_KEY = savedKey;
  });
});

describe('encryptFields / decryptFields', () => {
  it('should encrypt specified fields and leave others unchanged', () => {
    const data = { name: 'Alice', age: 30, email: 'alice@test.com' };
    const encrypted = encryptFields(data, ['name', 'email']);

    expect(encrypted.name).not.toBe('Alice');
    expect(encrypted.email).not.toBe('alice@test.com');
    expect(encrypted.age).toBe(30); // non-string field unchanged
  });

  it('should round-trip encryptFields then decryptFields', () => {
    const data = { name: 'Bob', phone: '555-1234', status: 'active' };
    const fields = ['name', 'phone'] as const;

    const encrypted = encryptFields(data, fields);
    const decrypted = decryptFields(encrypted, fields);

    expect(decrypted.name).toBe('Bob');
    expect(decrypted.phone).toBe('555-1234');
    expect(decrypted.status).toBe('active');
  });

  it('should not modify original object (immutability)', () => {
    const original = { name: 'Carol', secret: 'hidden' };
    const encrypted = encryptFields(original, ['secret']);

    expect(original.secret).toBe('hidden'); // original unchanged
    expect(encrypted.secret).not.toBe('hidden'); // new object has encrypted value
  });

  it('should skip non-string fields gracefully', () => {
    const data = { name: 'Dan', count: 42, active: true };
    // Passing non-string field keys should not throw
    const encrypted = encryptFields(data, ['name', 'count'] as unknown as (keyof typeof data)[]);
    expect(encrypted.count).toBe(42); // non-string left as-is
    expect(encrypted.name).not.toBe('Dan');
  });

  it('should skip empty string fields', () => {
    const data = { name: '', email: 'test@test.com' };
    const encrypted = encryptFields(data, ['name', 'email']);
    expect(encrypted.name).toBe(''); // empty string left as-is
    expect(encrypted.email).not.toBe('test@test.com');
  });
});
