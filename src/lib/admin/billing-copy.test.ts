import { describe, it, expect } from 'vitest';
import { billingFeatureLabel, billingPlanLine, billingStatusLabel } from './billing-copy';
import { ALL_PLANS } from '@/lib/billing/plans';

const price = (c: number) => `$${(c / 100).toFixed(2)}`;

describe('billing copy', () => {
  it('has an owner label for every feature any plan lists', () => {
    for (const plan of ALL_PLANS) {
      for (const f of plan.entitlements.features) {
        expect(billingFeatureLabel(f)).not.toBe(f);
        expect(billingFeatureLabel(f)).not.toMatch(/_/);
      }
    }
  });

  it('falls back to sentence case for an unknown feature key', () => {
    expect(billingFeatureLabel('custom_domains')).toBe('Custom domains');
  });

  it('never says "Free · Free"', () => {
    expect(billingPlanLine({ label: 'Free', priceCents: 0, interval: 'month' }, price)).toBe('Free plan');
    expect(billingPlanLine({ label: 'Starter', priceCents: 4900, interval: 'month' }, price)).toBe(
      'Starter plan · $49.00/month',
    );
  });

  it('turns provider statuses into words', () => {
    expect(billingStatusLabel('past_due')).toBe('Payment overdue');
    expect(billingStatusLabel('canceled')).toBe('Cancelled');
    expect(billingStatusLabel('something_new')).toBe('Something new');
  });
});
