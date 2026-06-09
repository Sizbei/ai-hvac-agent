import { describe, it, expect } from 'vitest';
import {
  extractionSchema,
  serviceRequestSchema,
  isExtractionComplete,
  isAddressComplete,
  isNameComplete,
  jobTypeForIssue,
  REQUIRED_EXTRACTION_FIELDS,
  type ExtractionResult,
} from '@/lib/ai/extraction-schema';

const completeExtraction: ExtractionResult = {
  issueType: 'heating_not_working',
  urgency: 'high',
  address: '123 Main St, Springfield, IL 62704',
  customerName: 'John Doe',
  customerPhone: '555-0100',
  customerEmail: 'john@example.com',
  description: 'Furnace stopped working last night',
  isHvacRelated: true,
};

describe('REQUIRED_EXTRACTION_FIELDS', () => {
  it('should contain issueType, urgency, address, customerPhone, customerName, and customerEmail', () => {
    expect(REQUIRED_EXTRACTION_FIELDS).toEqual([
      'issueType',
      'urgency',
      'address',
      'customerPhone',
      'customerName',
      'customerEmail',
    ]);
  });
});

describe('isAddressComplete', () => {
  it('accepts a full street + city + state + ZIP address', () => {
    expect(isAddressComplete('123 Main St, Springfield, IL 62704')).toBe(true);
  });

  it('accepts a full address without commas', () => {
    expect(isAddressComplete('123 Main Street Springfield IL 62704')).toBe(true);
  });

  it('accepts a unit/apartment in the address', () => {
    expect(isAddressComplete('456 Oak Ave Apt 3 Chicago IL 60614')).toBe(true);
  });

  it('rejects null', () => {
    expect(isAddressComplete(null)).toBe(false);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(isAddressComplete('')).toBe(false);
    expect(isAddressComplete('    ')).toBe(false);
  });

  it('rejects a partial address with too few tokens', () => {
    expect(isAddressComplete('5 Oak')).toBe(false);
  });

  it('rejects a street with no street number', () => {
    expect(isAddressComplete('Oak St')).toBe(false);
    expect(isAddressComplete('Main Street Springfield IL 62704')).toBe(false);
  });

  it('rejects a vague non-address', () => {
    expect(isAddressComplete('downtown')).toBe(false);
    expect(isAddressComplete('near the mall on the east side')).toBe(false);
  });

  it('rejects an otherwise-complete-looking address with no 5-digit ZIP', () => {
    expect(isAddressComplete('123 Main St Springfield Illinois')).toBe(false);
  });

  it('does not accept a non-ZIP digit run as a ZIP (needs exactly 5)', () => {
    expect(isAddressComplete('123 Main St Springfield IL 6270')).toBe(false);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(isAddressComplete('  123 Main St Springfield IL 62704  ')).toBe(true);
  });
});

describe('isNameComplete', () => {
  it('accepts a first + last name', () => {
    expect(isNameComplete('John Doe')).toBe(true);
  });

  it('accepts a three-part name', () => {
    expect(isNameComplete('Mary Jane Watson')).toBe(true);
  });

  it('rejects null', () => {
    expect(isNameComplete(null)).toBe(false);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(isNameComplete('')).toBe(false);
    expect(isNameComplete('   ')).toBe(false);
  });

  it('rejects a single (first-only) name', () => {
    expect(isNameComplete('Jane')).toBe(false);
  });

  it('rejects the skip sentinel', () => {
    expect(isNameComplete('__skipped__')).toBe(false);
  });

  it('tolerates extra interior whitespace', () => {
    expect(isNameComplete('John    Doe')).toBe(true);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(isNameComplete('  John Doe  ')).toBe(true);
  });
});

describe('isExtractionComplete', () => {
  it('should return true when all required fields are present and complete', () => {
    expect(isExtractionComplete(completeExtraction)).toBe(true);
  });

  it('should return false when issueType is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, issueType: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when urgency is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, urgency: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when address is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, address: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when address is empty string', () => {
    const extraction: ExtractionResult = { ...completeExtraction, address: '' };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when address is a partial (street only, no ZIP)', () => {
    const extraction: ExtractionResult = { ...completeExtraction, address: '123 Main St' };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when customerPhone is missing (now required)', () => {
    const extraction: ExtractionResult = { ...completeExtraction, customerPhone: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when customerName is null (now required)', () => {
    const extraction: ExtractionResult = { ...completeExtraction, customerName: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when customerName is only a first name', () => {
    const extraction: ExtractionResult = { ...completeExtraction, customerName: 'John' };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when email is null (email is now required)', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      customerEmail: null,
    };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when email is present but malformed', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      customerEmail: 'not-an-email',
    };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return true when all required fields incl. a valid email are set', () => {
    expect(isExtractionComplete(completeExtraction)).toBe(true);
  });

  it('should return false when all required fields are null', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      issueType: null,
      urgency: null,
      address: null,
      customerName: null,
    };
    expect(isExtractionComplete(extraction)).toBe(false);
  });
});

describe('extractionSchema', () => {
  it('should accept valid complete data', () => {
    const result = extractionSchema.parse(completeExtraction);
    expect(result.issueType).toBe('heating_not_working');
    expect(result.urgency).toBe('high');
    expect(result.address).toBe('123 Main St, Springfield, IL 62704');
  });

  it('should accept data with null optional fields', () => {
    const data = {
      ...completeExtraction,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
    };
    const result = extractionSchema.parse(data);
    expect(result.customerName).toBeNull();
    expect(result.customerPhone).toBeNull();
    expect(result.customerEmail).toBeNull();
  });

  it('should reject invalid urgency value', () => {
    const data = { ...completeExtraction, urgency: 'critical' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should reject invalid issueType value', () => {
    const data = { ...completeExtraction, issueType: 'plumbing' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should reject invalid email format', () => {
    const data = { ...completeExtraction, customerEmail: 'not-an-email' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should require description field', () => {
    const { description, ...withoutDescription } = completeExtraction;
    expect(() => extractionSchema.parse(withoutDescription)).toThrow();
  });

  it('should require isHvacRelated field', () => {
    const { isHvacRelated, ...withoutFlag } = completeExtraction;
    expect(() => extractionSchema.parse(withoutFlag)).toThrow();
  });
});

describe('new ServiceTitan-style optional slots', () => {
  it('accepts all new fields when present', () => {
    const parsed = extractionSchema.parse({
      ...completeExtraction,
      systemType: 'heat_pump',
      equipmentBrand: 'Trane',
      equipmentAgeBand: '10_to_15',
      propertyType: 'residential',
      ownerOccupant: 'owner',
      underWarranty: 'unknown',
      accessNotes: 'gate code 4821, dog in yard',
      systemDownStatus: 'fully_down',
      problemDuration: 'since yesterday',
      vulnerableOccupants: true,
      preferredWindow: 'morning',
      contactPreference: 'text',
      leadSource: 'google',
    });
    expect(parsed.systemType).toBe('heat_pump');
    expect(parsed.preferredWindow).toBe('morning');
    expect(parsed.vulnerableOccupants).toBe(true);
  });

  it('treats every new field as optional (absent is valid)', () => {
    expect(() => extractionSchema.parse(completeExtraction)).not.toThrow();
  });

  it('rejects an out-of-enum systemType', () => {
    expect(
      extractionSchema.safeParse({ ...completeExtraction, systemType: 'spaceship' })
        .success,
    ).toBe(false);
  });
});

describe('jobTypeForIssue (symptom → ServiceTitan job type)', () => {
  it('maps heating/cooling failures to no_heat/no_cool', () => {
    expect(jobTypeForIssue('heating_not_working')).toBe('no_heat');
    expect(jobTypeForIssue('cooling_not_working')).toBe('no_cool');
  });
  it('maps maintenance and installation', () => {
    expect(jobTypeForIssue('maintenance')).toBe('maintenance');
    expect(jobTypeForIssue('installation')).toBe('install');
  });
  it('falls back to service_call for generic symptoms, null for null', () => {
    expect(jobTypeForIssue('strange_noises')).toBe('service_call');
    expect(jobTypeForIssue('other')).toBe('service_call');
    expect(jobTypeForIssue(null)).toBe(null);
  });
});

describe('serviceRequestSchema (confirm payload)', () => {
  it('requires customerPhone', () => {
    const r = serviceRequestSchema.safeParse({
      issueType: 'cooling_not_working',
      urgency: 'high',
      address: '5 Oak St',
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      description: 'AC out',
    });
    expect(r.success).toBe(false);
  });

  it('requires a valid customerEmail (null/missing is rejected)', () => {
    const base = {
      issueType: 'cooling_not_working' as const,
      urgency: 'high' as const,
      address: '5 Oak St',
      customerName: 'Jane',
      customerPhone: '555-123-4567',
      description: 'AC out',
    };
    expect(serviceRequestSchema.safeParse({ ...base, customerEmail: null }).success).toBe(false);
    expect(serviceRequestSchema.safeParse({ ...base, customerEmail: 'nope' }).success).toBe(false);
    expect(serviceRequestSchema.safeParse({ ...base, customerEmail: 'jane@example.com' }).success).toBe(true);
  });

  it('accepts the new optional fields', () => {
    const parsed = serviceRequestSchema.parse({
      issueType: 'cooling_not_working',
      urgency: 'high',
      address: '5 Oak St',
      customerName: 'Jane',
      customerPhone: '555-123-4567',
      customerEmail: 'jane@example.com',
      description: 'AC out',
      systemType: 'central_ac',
      preferredWindow: 'afternoon',
      contactPreference: 'call',
      smsConsent: false,
      leadSource: 'referral',
    });
    expect(parsed.systemType).toBe('central_ac');
    expect(parsed.leadSource).toBe('referral');
  });
});
