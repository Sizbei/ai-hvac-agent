import { describe, it, expect } from 'vitest';
import {
  extractSlots,
  extractPhone,
  extractEmail,
  extractAddress,
} from './slot-extract';

describe('extractPhone', () => {
  it('matches dashed format', () => {
    expect(extractPhone('call me at 555-123-4567')).toBe('555-123-4567');
  });

  it('matches parenthesized format', () => {
    expect(extractPhone('reach me (555) 123-4567 anytime')).toBe(
      '(555) 123-4567',
    );
  });

  it('matches dotted format', () => {
    expect(extractPhone('phone 555.123.4567')).toBe('555.123.4567');
  });

  it('matches bare 10-digit format', () => {
    expect(extractPhone('number is 5551234567')).toBe('5551234567');
  });

  it('matches space-separated format', () => {
    expect(extractPhone('555 123 4567 is my cell')).toBe('555 123 4567');
  });

  it('matches with +1 country code', () => {
    expect(extractPhone('call +1 555-123-4567')).toBe('+1 555-123-4567');
  });

  it('matches +1 with no separator', () => {
    expect(extractPhone('+15551234567')).toBe('+15551234567');
  });

  it('returns null for a bare 5-digit zip', () => {
    expect(extractPhone('I live in 62704')).toBeNull();
  });

  it('returns null for a reference number like REF-12345', () => {
    expect(extractPhone('ticket REF-12345')).toBeNull();
  });

  it('returns null when no phone is present', () => {
    expect(extractPhone('my AC is broken')).toBeNull();
  });

  it('returns null for a 9-digit number', () => {
    expect(extractPhone('id 123456789')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPhone('')).toBeNull();
  });
});

describe('extractEmail', () => {
  it('matches a standard email', () => {
    expect(extractEmail('email me at jane.doe@example.com please')).toBe(
      'jane.doe@example.com',
    );
  });

  it('matches an email with plus addressing', () => {
    expect(extractEmail('contact: user+tag@sub.domain.co')).toBe(
      'user+tag@sub.domain.co',
    );
  });

  it('returns null for a non-email string', () => {
    expect(extractEmail('this is not an email address')).toBeNull();
  });

  it('returns null for an @ with no domain tld', () => {
    expect(extractEmail('handle @someone here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractEmail('')).toBeNull();
  });
});

describe('extractAddress', () => {
  it('extracts a full address with city/state/zip', () => {
    expect(
      extractAddress('the address is 742 Evergreen Terrace, Springfield, IL 62704'),
    ).toBe('742 Evergreen Terrace, Springfield, IL 62704');
  });

  it('extracts a short street address with abbreviated suffix', () => {
    expect(extractAddress('123 Main St')).toBe('123 Main St');
  });

  it('extracts an address with a unit', () => {
    expect(extractAddress('456 Oak Avenue Apt 2')).toBe('456 Oak Avenue Apt 2');
  });

  it('extracts a boulevard address', () => {
    expect(extractAddress('go to 1600 Pennsylvania Blvd today')).toBe(
      '1600 Pennsylvania Blvd',
    );
  });

  it('returns null when no street pattern is present', () => {
    expect(extractAddress('my AC is broken')).toBeNull();
  });

  it('returns null for a bare city/state', () => {
    expect(extractAddress('I live in Springfield, IL')).toBeNull();
  });

  it('returns null for a bare zip', () => {
    expect(extractAddress('62704')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractAddress('')).toBeNull();
  });
});

describe('extractSlots', () => {
  it('extracts all three slots from a combined message', () => {
    const message =
      "I'm Jane, 555-123-9876, jane@example.com, 742 Evergreen Terrace, Springfield IL 62704";
    expect(extractSlots(message)).toEqual({
      address: '742 Evergreen Terrace, Springfield IL 62704',
      phone: '555-123-9876',
      email: 'jane@example.com',
    });
  });

  it('extracts phone and address without email', () => {
    const message =
      "I'm Jane, 555-123-9876, 742 Evergreen Terrace, Springfield IL 62704";
    const slots = extractSlots(message);
    expect(slots.phone).toBe('555-123-9876');
    expect(slots.address).toBe('742 Evergreen Terrace, Springfield IL 62704');
    expect(slots.email).toBeNull();
  });

  it('returns all null for empty string', () => {
    expect(extractSlots('')).toEqual({
      address: null,
      phone: null,
      email: null,
    });
  });

  it('returns all null when no slots are present', () => {
    expect(extractSlots('my heater stopped working last night')).toEqual({
      address: null,
      phone: null,
      email: null,
    });
  });
});
