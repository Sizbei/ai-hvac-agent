import { describe, expect, it } from 'vitest';
import { mergeBusinessInfo, type BusinessInfoDraft } from './business-info-merge';
import type { BusinessInfo } from './org-config-types';

const emptyDraft: BusinessInfoDraft = {
  serviceArea: '',
  businessHours: '',
  phone: '',
  email: '',
  licensedInsured: '',
  paymentMethods: '',
  website: '',
  financingAvailable: false,
};

describe('mergeBusinessInfo', () => {
  it('keeps a stored key the panel does not edit', () => {
    // Simulates a key added to the schema later that this panel has no field for.
    const stored = { phone: '555', futureKey: 'keep me' } as unknown as BusinessInfo;
    const out = mergeBusinessInfo(stored, { ...emptyDraft, phone: '555' }) as Record<string, unknown>;
    expect(out.futureKey).toBe('keep me');
  });

  it('keeps the stored email when only another field changes', () => {
    const stored: BusinessInfo = { email: 'office@example.com', phone: '555', serviceArea: 'Tri-Cities' };
    const out = mergeBusinessInfo(stored, {
      ...emptyDraft,
      email: 'office@example.com',
      phone: '555-0100',
      serviceArea: 'Tri-Cities',
    });
    expect(out).toEqual({
      email: 'office@example.com',
      phone: '555-0100',
      serviceArea: 'Tri-Cities',
      financingAvailable: false,
    });
  });

  it('removes a field the user cleared and trims the rest', () => {
    const stored: BusinessInfo = { website: 'https://a.example', phone: '555' };
    const out = mergeBusinessInfo(stored, { ...emptyDraft, phone: '  555-0199 ', financingAvailable: true });
    expect(out).toEqual({ phone: '555-0199', financingAvailable: true });
  });

  it('does not mutate the stored object', () => {
    const stored: BusinessInfo = { email: 'a@example.com' };
    mergeBusinessInfo(stored, emptyDraft);
    expect(stored).toEqual({ email: 'a@example.com' });
  });
});
