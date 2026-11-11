export type EmptyStatePage =
  | 'requests'
  | 'pricebook'
  | 'estimates'
  | 'invoices'
  | 'dispatch';

/** Outline when the page header already holds the same primary action. */
export type EmptyActionVariant = 'default' | 'outline';

export type EmptyAction =
  | { readonly kind: 'callback'; readonly label: string; readonly variant: EmptyActionVariant }
  | { readonly kind: 'link'; readonly label: string; readonly href: string; readonly variant: EmptyActionVariant };

/**
 * The one primary action for a page's day-one empty state. Null when filters
 * are active: the existing clear-filters action stays and nothing replaces it.
 */
export function emptyActionFor(
  page: EmptyStatePage,
  { hasActiveFilters }: { readonly hasActiveFilters: boolean },
): EmptyAction | null {
  if (hasActiveFilters) return null;
  switch (page) {
    // The header's primary button is the same action: one primary per screen.
    case 'requests':
      return { kind: 'callback', label: 'New request', variant: 'outline' };
    case 'pricebook':
      return { kind: 'callback', label: 'Add item', variant: 'outline' };
    case 'estimates':
      return { kind: 'callback', label: 'New estimate', variant: 'outline' };
    case 'invoices':
      return { kind: 'link', label: 'Open estimates', href: '/admin/estimates', variant: 'default' };
    case 'dispatch':
      return { kind: 'link', label: 'Open staff', href: '/admin/staff', variant: 'default' };
  }
}
