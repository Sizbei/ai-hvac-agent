import { describe, it, expect } from 'vitest';
import {
  extractSlots,
  extractPhone,
  extractEmail,
  extractAddress,
  extractAddressLoose,
  extractAddressAtAddressStep,
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

describe('extractAddressAtAddressStep', () => {
  it('captures a standard US address (delegates to loose)', () => {
    expect(
      extractAddressAtAddressStep('87 Harvard Street, Springfield, Massachusetts 01104'),
    ).toBe('87 Harvard Street, Springfield, Massachusetts 01104');
  });

  it('captures an address with no leading house number (the re-ask bug)', () => {
    expect(
      extractAddressAtAddressStep('Rockaway Freeway, New York, New York 11693'),
    ).toBe('Rockaway Freeway, New York, New York 11693');
  });

  it('captures a non-US address with a number mid-string', () => {
    expect(
      extractAddressAtAddressStep('Route Nationale # 3, Commune Pignon, Nord'),
    ).toBe('Route Nationale # 3, Commune Pignon, Nord');
  });

  it('keeps a suffix-less Australian address whole (re-ask loop bug)', () => {
    // "Crescent" is not a recognized street suffix and "3350" is a 4-digit
    // postcode, so the strict + loose extractors truncate at the first comma
    // ("21 Avoca Crescent"). The step extractor must return the WHOLE reply so
    // the chat route stores city/state/postcode and never fires a spurious
    // city/ZIP follow-up. Regression for the transcript re-ask loop.
    expect(
      extractAddressAtAddressStep('21 Avoca Crescent, Ballarat, Victoria 3350'),
    ).toBe('21 Avoca Crescent, Ballarat, Victoria 3350');
    // Document why ordering matters in the route: the loose extractor truncates
    // the same input, so it must NOT be preferred at the address step.
    expect(
      extractAddressLoose('21 Avoca Crescent, Ballarat, Victoria 3350'),
    ).toBe('21 Avoca Crescent');
  });

  it('captures a suffix-less number-led address', () => {
    expect(extractAddressAtAddressStep('123 Main')).toBe('123 Main');
  });

  it('trims trailing punctuation', () => {
    expect(
      extractAddressAtAddressStep('Rockaway Freeway, New York 11693.'),
    ).toBe('Rockaway Freeway, New York 11693');
  });

  it('rejects an empty reply', () => {
    expect(extractAddressAtAddressStep('   ')).toBeNull();
  });

  it('rejects a refusal / redirect reply', () => {
    expect(extractAddressAtAddressStep('skip')).toBeNull();
    expect(extractAddressAtAddressStep('can someone call me instead')).toBeNull();
  });

  it('rejects a one-word non-address reply', () => {
    expect(extractAddressAtAddressStep('hello')).toBeNull();
  });

  it('rejects conversational 3+-word prose that is not an address', () => {
    // The 3+-word verbatim path used to store ANY multi-word reply. A refusal,
    // uncertainty, or redirect sentence (no digit, no comma) must not become the
    // service address (review).
    for (const reply of [
      "i don't know the address yet",
      'let me check with my wife',
      'it is a rental property',
      'can you look it up for me',
    ]) {
      expect(extractAddressAtAddressStep(reply)).toBeNull();
    }
  });

  it('still accepts a comma/number-less international address (no false reject)', () => {
    // No pronoun/verb prose markers → trusted verbatim, preserving the
    // suffix-less international-address fix.
    expect(extractAddressAtAddressStep('Kings Highway Brooklyn')).toBe(
      'Kings Highway Brooklyn',
    );
    expect(extractAddressAtAddressStep('Rue de la Paix Paris')).toBe(
      'Rue de la Paix Paris',
    );
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

describe('extractAddressLoose (used when the address question is pending)', () => {
  it('still matches a full suffixed address', async () => {
    const { extractAddressLoose } = await import('./slot-extract');
    expect(extractAddressLoose('123 Main St, Austin TX 78704')).toContain('123 Main');
  });

  it('matches a suffix-less number + street name when the address was asked for', async () => {
    const { extractAddressLoose } = await import('./slot-extract');
    expect(extractAddressLoose('123 Main')).toBe('123 Main');
    expect(extractAddressLoose('27 Larkspur, Pflugerville')).toContain('27 Larkspur');
  });

  it('does NOT treat a bare duration/quantity as an address', async () => {
    const { extractAddressLoose } = await import('./slot-extract');
    expect(extractAddressLoose('10 years')).toBeNull();
    expect(extractAddressLoose('about 5')).toBeNull();
  });

  it('returns null for clearly non-address text', async () => {
    const { extractAddressLoose } = await import('./slot-extract');
    expect(extractAddressLoose('my ac is broken')).toBeNull();
  });
});
