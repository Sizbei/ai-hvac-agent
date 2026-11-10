import { describe, it, expect } from 'vitest';
import { emptyActionFor } from './empty-state-actions';

describe('emptyActionFor', () => {
  it('maps each page to its single day-one action', () => {
    expect(emptyActionFor('requests', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'New request',
    });
    expect(emptyActionFor('pricebook', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'Add item',
    });
    expect(emptyActionFor('estimates', { hasActiveFilters: false })).toEqual({
      kind: 'callback',
      label: 'New estimate',
    });
    expect(emptyActionFor('invoices', { hasActiveFilters: false })).toEqual({
      kind: 'link',
      label: 'Open estimates',
      href: '/admin/estimates',
    });
    expect(emptyActionFor('dispatch', { hasActiveFilters: false })).toEqual({
      kind: 'link',
      label: 'Open staff',
      href: '/admin/staff',
    });
  });

  it.each(['requests', 'pricebook', 'estimates', 'invoices', 'dispatch'] as const)(
    'filters active on %s -> null (the clear-filters action stays)',
    (page) => {
      expect(emptyActionFor(page, { hasActiveFilters: true })).toBeNull();
    },
  );
});
