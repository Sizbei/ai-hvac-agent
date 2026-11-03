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
   * count; 'setup' = setup steps left. */
  readonly badge?: 'unscheduled' | 'setup';
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
      { label: 'Conversations', href: '/admin/conversations', icon: MessagesSquare },
      { label: 'AI Insights', href: '/admin/insights', icon: BarChart3 },
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
      { label: 'Operations', href: '/admin/operations', icon: Gauge },
      { label: 'Reports', href: '/admin/reports', icon: TrendingUp },
    ],
  },
  {
    heading: 'Integrations',
    items: [
      { label: 'Chatbot settings', href: '/admin/settings', icon: Settings },
      { label: 'Integrations', href: '/admin/integrations', icon: Plug },
      { label: 'FP import', href: '/admin/fieldpulse-import', icon: Download },
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

const GROUPS_BY_PLACEMENT: Record<SetupPlacement, readonly NavGroup[]> = {
  operations: withSetup('operations'),
  integrations: withSetup('integrations'),
};

/**
 * The nav groups for the sidebar, the mobile title and ⌘K search: Setup second
 * in Operations (after Dashboard) or last in Integrations. Stable reference per
 * placement so consumers can memoise on it.
 */
export function navGroupsFor(placement: SetupPlacement): readonly NavGroup[] {
  return GROUPS_BY_PLACEMENT[placement];
}
