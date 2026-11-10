import {
  LayoutDashboard,
  CalendarRange,
  CalendarClock,
  Map,
  ClipboardList,
  MessagesSquare,
  BarChart3,
  Building2,
  Settings,
  ScrollText,
  Tags,
  MessageSquare,
  Plug,
  FileText,
  Receipt,
  TrendingUp,
  BadgeCheck,
  Star,
  Boxes,
  Calculator,
  Gauge,
  Download,
  UsersRound,
  ListChecks,
} from 'lucide-react';

export interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: typeof ClipboardList;
  /** Match the active state on the exact path only (for the index route, whose
   * href is a prefix of every other admin route). */
  readonly exact?: boolean;
  /** Which notification badge the item shows: 'unscheduled' = unscheduled-jobs
   * count; 'setup' = setup steps left; 'needsAction' = conversations that need
   * action (the inbox's "Needs action" filter). */
  readonly badge?: 'unscheduled' | 'setup' | 'needsAction';
}

export interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/** Every group without the Setup item; `navGroupsFor` places it. */
const BASE_NAV_GROUPS: readonly NavGroup[] = [
  {
    heading: 'Operations',
    items: [
      { label: 'Dashboard', href: '/admin/', icon: LayoutDashboard, exact: true },
      { label: 'Calendar', href: '/admin/calendar', icon: CalendarClock, badge: 'unscheduled' },
      { label: 'Dispatch', href: '/admin/dispatch', icon: CalendarRange },
      { label: 'Map', href: '/admin/map', icon: Map },
      { label: 'Requests', href: '/admin/requests', icon: ClipboardList },
    ],
  },
  {
    heading: 'Customers',
    items: [
      { label: 'Conversations', href: '/admin/conversations', icon: MessagesSquare, badge: 'needsAction' },
      { label: 'Customers', href: '/admin/customers', icon: Building2 },
      { label: 'Reviews', href: '/admin/reviews', icon: Star },
      { label: 'Communications', href: '/admin/communications/templates', icon: MessageSquare },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { label: 'Staff', href: '/admin/staff', icon: UsersRound },
      { label: 'Pricebook', href: '/admin/pricebook', icon: Tags },
      { label: 'Inventory', href: '/admin/inventory', icon: Boxes },
      { label: 'Membership plans', href: '/admin/membership-plans', icon: BadgeCheck },
    ],
  },
  {
    heading: 'Money',
    items: [
      { label: 'Estimates', href: '/admin/estimates', icon: FileText },
      { label: 'Invoices', href: '/admin/invoices', icon: Receipt },
      { label: 'Accounting', href: '/admin/accounting', icon: Calculator },
    ],
  },
  {
    // Read-only numbers about the business and the assistant (not money).
    heading: 'Insights',
    items: [
      { label: 'Operations', href: '/admin/operations', icon: Gauge },
      { label: 'Reports', href: '/admin/reports', icon: TrendingUp },
      { label: 'AI insights', href: '/admin/insights', icon: BarChart3 },
    ],
  },
  {
    heading: 'Integrations',
    items: [
      { label: 'Settings', href: '/admin/settings', icon: Settings },
      { label: 'Integrations', href: '/admin/integrations', icon: Plug },
      { label: 'FieldPulse import', href: '/admin/fieldpulse-import', icon: Download },
      { label: 'Audit log', href: '/admin/audit-log', icon: ScrollText },
    ],
  },
] as const;

/** Where the Setup item sits — decided server-side per page load (spec §2). */
export type SetupPlacement = 'operations' | 'integrations';

const SETUP_ITEM: NavItem = {
  label: 'Setup',
  href: '/admin/setup',
  icon: ListChecks,
  badge: 'setup',
};

function withSetup(placement: SetupPlacement): readonly NavGroup[] {
  return BASE_NAV_GROUPS.map((group) => {
    if (placement === 'operations' && group.heading === 'Operations') {
      const [first, ...rest] = group.items;
      return { ...group, items: [first, SETUP_ITEM, ...rest] };
    }
    if (placement === 'integrations' && group.heading === 'Integrations') {
      return { ...group, items: [...group.items, SETUP_ITEM] };
    }
    return group;
  });
}

export interface NavOptions {
  /** The org's Map switch; off drops the Map item everywhere. */
  readonly map: boolean;
}

const MAP_HREF = '/admin/map';

function withoutMap(groups: readonly NavGroup[]): readonly NavGroup[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== MAP_HREF) }));
}

const GROUPS: Record<SetupPlacement, Record<'on' | 'off', readonly NavGroup[]>> = {
  operations: { on: withSetup('operations'), off: withoutMap(withSetup('operations')) },
  integrations: { on: withSetup('integrations'), off: withoutMap(withSetup('integrations')) },
};

/**
 * The nav groups for the sidebar, the mobile title and ⌘K search: Setup second
 * in Operations (after Dashboard) or last in Integrations; Map only when the
 * org's switch is on. Stable reference per (placement, map) so consumers can
 * memoise on it.
 */
export function navGroupsFor(placement: SetupPlacement, opts: NavOptions): readonly NavGroup[] {
  return GROUPS[placement][opts.map ? 'on' : 'off'];
}

/** Drop trailing slashes so "/admin/" and "/admin" compare equal. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Whether `pathname` is on `item`'s page. Exact items (Dashboard, href
 * "/admin/") match only their own path; others also match sub-pages.
 */
export function navItemMatches(pathname: string, item: Pick<NavItem, 'href' | 'exact'>): boolean {
  const path = normalizePath(pathname);
  const href = normalizePath(item.href);
  if (item.exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

/** The nav label for the current page (mobile top bar), or undefined. */
export function navLabelFor(
  pathname: string,
  placement: SetupPlacement,
  opts: NavOptions,
): string | undefined {
  for (const group of navGroupsFor(placement, opts)) {
    for (const item of group.items) {
      if (navItemMatches(pathname, item)) return item.label;
    }
  }
  return undefined;
}
