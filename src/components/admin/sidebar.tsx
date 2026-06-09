'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarRange,
  CalendarClock,
  ClipboardList,
  MessagesSquare,
  BarChart3,
  UsersRound,
  Building2,
  Settings,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Thermometer,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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

const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard, exact: true },
  { label: 'Calendar', href: '/admin/calendar', icon: CalendarClock, badge: 'unscheduled' },
  { label: 'Dispatch', href: '/admin/dispatch', icon: CalendarRange },
  { label: 'Requests', href: '/admin/requests', icon: ClipboardList },
  { label: 'Conversations', href: '/admin/conversations', icon: MessagesSquare },
  { label: 'AI Insights', href: '/admin/insights', icon: BarChart3 },
  { label: 'Customers', href: '/admin/customers', icon: Building2 },
  { label: 'Staff', href: '/admin/staff', icon: UsersRound },
  { label: 'Chatbot Settings', href: '/admin/settings', icon: Settings },
  { label: 'Audit Log', href: '/admin/audit-log', icon: ScrollText },
] as const;

interface SidebarProps {
  readonly adminName: string;
  readonly adminEmail: string;
  readonly isMobileOpen: boolean;
  readonly onMobileClose: () => void;
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
      if (mobile) {
        setIsCollapsed(true);
      }
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

  // Mobile: overlay sidebar
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        {isMobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50"
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

        {/* Slide-out sidebar */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 w-64 border-r bg-card transition-transform duration-200',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex h-14 items-center gap-2 px-4">
              <Thermometer className="size-6 shrink-0 text-primary" />
              <span className="text-lg font-semibold text-primary">HVAC</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                onClick={onMobileClose}
              >
                <X className="size-4" />
              </Button>
            </div>

            <Separator />

            {/* Nav */}
            <nav className="flex-1 space-y-1 px-2 py-2">
              {NAV_ITEMS.map((item) => {
                const isActive = item.exact
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Icon className="size-5 shrink-0" />
                    <span>{item.label}</span>
                    {item.badge === 'unscheduled' && badge.visible && (
                      <span
                        aria-label={badge.srLabel}
                        className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
                      >
                        {badge.label}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            <Separator />

            {/* User info + logout */}
            <div className="space-y-2 px-2 py-2">
              <div className="rounded-lg bg-muted/50 px-3 py-2">
                <p className="truncate text-sm font-medium">{adminName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {adminEmail}
                </p>
              </div>
              <Button
                variant="ghost"
                size="default"
                onClick={handleLogout}
                className="w-full justify-start text-muted-foreground hover:text-destructive"
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
        'shrink-0 border-r bg-card transition-all duration-200',
        isCollapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 px-4">
          <Thermometer className="size-6 shrink-0 text-primary" />
          {!isCollapsed && (
            <span className="text-lg font-semibold text-primary">HVAC</span>
          )}
        </div>

        <Separator />

        {/* Nav */}
        <nav className="flex-1 space-y-1 px-2 py-2">
          <TooltipProvider>
            {NAV_ITEMS.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : pathname.startsWith(item.href);
              const Icon = item.icon;

              const showBadge = item.badge === 'unscheduled' && badge.visible;
              const linkContent = (
                <Link
                  href={item.href}
                  className={cn(
                    'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    isCollapsed && 'justify-center px-2'
                  )}
                >
                  <Icon className="size-5 shrink-0" />
                  {!isCollapsed && <span>{item.label}</span>}
                  {showBadge && !isCollapsed && (
                    <span
                      aria-label={badge.srLabel}
                      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
                    >
                      {badge.label}
                    </span>
                  )}
                  {showBadge && isCollapsed && (
                    <span
                      aria-label={badge.srLabel}
                      className="absolute right-1 top-1 size-2 rounded-full bg-amber-500"
                    />
                  )}
                </Link>
              );

              if (isCollapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger render={<div />}>
                      {linkContent}
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return <div key={item.href}>{linkContent}</div>;
            })}
          </TooltipProvider>
        </nav>

        <Separator />

        {/* Bottom section */}
        <div className="space-y-2 px-2 py-2">
          {/* Collapse toggle */}
          <Button
            variant="ghost"
            size={isCollapsed ? 'icon' : 'default'}
            onClick={toggleCollapse}
            className={cn('w-full', !isCollapsed && 'justify-start')}
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

          {/* User info */}
          {!isCollapsed && (
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="truncate text-sm font-medium">{adminName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {adminEmail}
              </p>
            </div>
          )}

          {/* Logout */}
          <TooltipProvider>
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleLogout}
                    className="w-full text-muted-foreground hover:text-destructive"
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
                className="w-full justify-start text-muted-foreground hover:text-destructive"
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
