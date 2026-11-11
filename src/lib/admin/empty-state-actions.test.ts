import { describe, it, expect } from 'vitest';
import { emptyActionFor } from './empty-state-actions';

describe('emptyActionFor', () => {
  it('maps each page to its single day-one action', () => {
    expect(emptyActionFor('requests', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'New request',
      variant: 'outline',
    });
    expect(emptyActionFor('pricebook', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'Add item',
      variant: 'outline',
    });
    expect(emptyActionFor('estimates', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'New estimate',
      variant: 'outline',
    });
    expect(emptyActionFor('invoices', { hasActiveFilters: false })).toEqual({
      kind: 'link',
      label: 'Open estimates',
      href: '/admin/estimates',
      variant: 'default',
    });
    expect(emptyActionFor('dispatch', { hasActiveFilters: false })).toEqual({
      kind: 'link',
      label: 'Open staff',
      href: '/admin/staff',
      variant: 'default',
    });
  });

  it('is outline when the page header already holds the same primary action', () => {
    for (const page of ['requests', 'pricebook', 'estimates'] as const) {
      expect(emptyActionFor(page, { hasActiveFilters: false })?.variant).toBe('outline');
    }
  });

  it.each(['requests', 'pricebook', 'estimates', 'invoices', 'dispatch'] as const)(
    'filters active on %s -> null (the clear-filters action stays)',
    (page) => {
      expect(emptyActionFor(page, { hasActiveFilters: true })).toBeNull();
    },
  );
});
