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
} from 'lucide-react';

export interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: typeof ClipboardList;
  /** Match the active state on the exact path only (for the index route, whose
   * href is a prefix of every other admin route). */
  readonly exact?: boolean;
  /** When 'unscheduled', the item shows the unscheduled-jobs notification badge. */
  readonly badge?: 'unscheduled';
}

export interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
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
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { label: 'Staff', href: '/admin/staff', icon: UsersRound },
      { label: 'Pricebook', href: '/admin/pricebook', icon: Tags },
      { label: 'Inventory', href: '/admin/inventory', icon: Boxes },
      { label: 'Membership Plans', href: '/admin/membership-plans', icon: BadgeCheck },
      { label: 'Estimates', href: '/admin/estimates', icon: FileText },
      { label: 'Invoices', href: '/admin/invoices', icon: Receipt },
      { label: 'Operations', href: '/admin/operations', icon: Gauge },
      { label: 'Reports', href: '/admin/reports', icon: TrendingUp },
      { label: 'Accounting', href: '/admin/accounting', icon: Calculator },
      { label: 'Reviews', href: '/admin/reviews', icon: Star },
      { label: 'Chatbot Settings', href: '/admin/settings', icon: Settings },
      { label: 'Communications', href: '/admin/communications/templates', icon: MessageSquare },
      { label: 'Audit Log', href: '/admin/audit-log', icon: ScrollText },
    ],
  },
  {
    heading: 'Integrations',
    items: [
      { label: 'Integrations', href: '/admin/integrations', icon: Plug },
      { label: 'FP Import', href: '/admin/fieldpulse-import', icon: Download },
    ],
  },
] as const;
