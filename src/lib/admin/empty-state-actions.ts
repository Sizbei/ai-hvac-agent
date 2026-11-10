export type EmptyStatePage =
  | 'requests'
  | 'pricebook'
  | 'estimates'
  | 'invoices'
  | 'dispatch';

export type EmptyAction =
  | { readonly kind: 'callback'; readonly label: string }
  | { readonly kind: 'link'; readonly label: string; readonly href: string };

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
    case 'requests':
      return { kind: 'callback', label: 'New request' };
    case 'pricebook':
      return { kind: 'callback', label: 'Add item' };
    case 'estimates':
      return { kind: 'callback', label: 'New estimate' };
    case 'invoices':
      return { kind: 'link', label: 'Open estimates', href: '/admin/estimates' };
    case 'dispatch':
      return { kind: 'link', label: 'Open staff', href: '/admin/staff' };
  }
}
