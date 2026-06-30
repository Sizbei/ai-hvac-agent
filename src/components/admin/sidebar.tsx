'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarRange,
  CalendarClock,
  Map,
  ClipboardList,
  MessagesSquare,
  BarChart3,
  UsersRound,
  Building2,
  Settings,
  ScrollText,
  Tags,
  ChevronLeft,
  ChevronRight,
  LogOut,
  X,
  MessageSquare,
  Plug,
  FileText,
  Receipt,
  TrendingUp,
  BadgeCheck,
  Star,
  Boxes,
  Calculator,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BrandMark } from '@/components/admin/brand-mark';
import { useUnscheduledCount } from '@/hooks/use-unscheduled-count';
import { unscheduledBadge } from '@/lib/admin/unscheduled-badge';
import { cn } from '@/lib/utils';

interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: typeof ClipboardList;
  /** Match the active state on the exact path only (for the index route, whose
   * href is a prefix of every other admin route). */
  readonly exact?: boolean;
  /** When 'unscheduled', the item shows the unscheduled-jobs notification badge. */
  readonly badge?: 'unscheduled';
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
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
    ],
  },
] as const;

interface SidebarProps {
  readonly adminName: string;
  readonly adminEmail: string;
  readonly isMobileOpen: boolean;
  readonly onMobileClose: () => void;
}

/** Two-character initials for the user avatar (e.g. "Raymond Chen" -> "RC"). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({
  adminName,
  adminEmail,
  isMobileOpen,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const [isMobile, setIsMobile] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { count: unscheduledCount } = useUnscheduledCount();
  const badge = unscheduledBadge(unscheduledCount);

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // Collapse on mobile; expand the desktop rail again when widening back.
      setIsCollapsed(mobile);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    onMobileClose();
  }, [pathname, onMobileClose]);

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  }, []);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const isItemActive = useCallback(
    (item: NavItem) =>
      item.exact ? pathname === item.href : pathname.startsWith(item.href),
    [pathname],
  );

  const renderNavLink = useCallback(
    (item: NavItem, collapsed: boolean) => {
      const isActive = isItemActive(item);
      const Icon = item.icon;
      const showBadge = item.badge === 'unscheduled' && badge.visible;
      return (
        <Link
          href={item.href}
          className={cn(
            'group/nav relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive
              ? 'bg-white/10 text-white'
              : 'text-white/65 hover:bg-white/[0.06] hover:text-white',
            collapsed && 'justify-center px-2',
          )}
        >
          {/* Active accent bar */}
          {isActive && (
            <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" />
          )}
          <Icon
            className={cn(
              'size-5 shrink-0 transition-colors',
              isActive ? 'text-primary' : 'text-white/70 group-hover/nav:text-white',
            )}
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
          {showBadge && !collapsed && (
            <span
              aria-label={badge.srLabel}
              className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
            >
              {badge.label}
            </span>
          )}
          {showBadge && collapsed && (
            <span
              aria-label={badge.srLabel}
              className="absolute right-1 top-1 size-2 rounded-full bg-amber-500 ring-2 ring-[oklch(0.21_0.05_258)]"
            />
          )}
        </Link>
      );
    },
    [badge, isItemActive],
  );

  // Shared navy surface for both mobile and desktop sidebars.
  const surfaceClass =
    'bg-gradient-to-b from-[oklch(0.24_0.055_258)] to-[oklch(0.18_0.05_260)] text-white';

  // Mobile: overlay sidebar
  if (isMobile) {
    return (
      <>
        {isMobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={onMobileClose}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onMobileClose();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Close sidebar"
          />
        )}

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200',
            surfaceClass,
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex h-16 items-center px-4">
              <BrandMark onDark />
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-white/70 hover:bg-white/10 hover:text-white"
                onClick={onMobileClose}
                aria-label="Close navigation"
              >
                <X className="size-4" />
              </Button>
            </div>

            <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
              {NAV_GROUPS.map((group) => (
                <div key={group.heading} className="space-y-1">
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
                    {group.heading}
                  </p>
                  {group.items.map((item) => (
                    <div key={item.href}>{renderNavLink(item, false)}</div>
                  ))}
                </div>
              ))}
            </nav>

            <div className="border-t border-white/10 px-3 py-3">
              <div className="flex items-center gap-3 rounded-lg bg-white/[0.06] px-3 py-2">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
                  {initialsOf(adminName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{adminName}</p>
                  <p className="truncate text-xs text-white/50">{adminEmail}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="default"
                onClick={handleLogout}
                className="mt-1 w-full justify-start text-white/65 hover:bg-white/10 hover:text-white"
              >
                <LogOut className="size-4" />
                <span>Sign Out</span>
              </Button>
            </div>
          </div>
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar
  return (
    <aside
      className={cn(
        'shrink-0 transition-all duration-200',
        surfaceClass,
        isCollapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div
          className={cn(
            'flex h-16 items-center px-4',
            isCollapsed && 'justify-center px-0',
          )}
        >
          <BrandMark onDark compact={isCollapsed} />
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
          <TooltipProvider>
            {NAV_GROUPS.map((group, groupIndex) => (
              <div key={group.heading} className="space-y-1">
                {!isCollapsed && (
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
                    {group.heading}
                  </p>
                )}
                {/* Collapsed: a short rule separates groups (not above the first). */}
                {isCollapsed && groupIndex > 0 && (
                  <div className="mx-auto mb-1 h-px w-6 bg-white/10" aria-hidden="true" />
                )}
                {group.items.map((item) => {
                  if (isCollapsed) {
                    return (
                      <Tooltip key={item.href}>
                        <TooltipTrigger render={<div />}>
                          {renderNavLink(item, true)}
                        </TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    );
                  }
                  return <div key={item.href}>{renderNavLink(item, false)}</div>;
                })}
              </div>
            ))}
          </TooltipProvider>
        </nav>

        {/* Bottom section */}
        <div className="border-t border-white/10 px-3 py-3">
          {/* User info */}
          {!isCollapsed && (
            <div className="mb-1 flex items-center gap-3 rounded-lg bg-white/[0.06] px-3 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
                {initialsOf(adminName)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{adminName}</p>
                <p className="truncate text-xs text-white/50">{adminEmail}</p>
              </div>
            </div>
          )}

          {/* Collapse toggle */}
          <Button
            variant="ghost"
            size={isCollapsed ? 'icon' : 'default'}
            onClick={toggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : undefined}
            className={cn(
              'w-full text-white/65 hover:bg-white/10 hover:text-white',
              !isCollapsed && 'justify-start',
            )}
          >
            {isCollapsed ? (
              <ChevronRight className="size-4" />
            ) : (
              <>
                <ChevronLeft className="size-4" />
                <span>Collapse</span>
              </>
            )}
          </Button>

          {/* Logout */}
          <TooltipProvider>
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleLogout}
                    className="w-full text-white/65 hover:bg-white/10 hover:text-red-300"
                  >
                    <LogOut className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Sign Out</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                variant="ghost"
                size="default"
                onClick={handleLogout}
                className="w-full justify-start text-white/65 hover:bg-white/10 hover:text-red-300"
              >
                <LogOut className="size-4" />
                <span>Sign Out</span>
              </Button>
            )}
          </TooltipProvider>
        </div>
      </div>
    </aside>
  );
}
