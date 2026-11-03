'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  LogOut,
  X,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BrandMark } from '@/components/admin/brand-mark';
import { EnvBadge } from '@/components/admin/env-badge';
// NAV_GROUPS lives in a shared module so the ⌘K search can offer page-navigation
// from the same source of truth (no drift with the sidebar).
import { navGroupsFor, type NavItem, type SetupPlacement } from './nav-items';
import { useUnscheduledCount } from '@/hooks/use-unscheduled-count';
import { unscheduledBadge, type UnscheduledBadge } from '@/lib/admin/unscheduled-badge';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import { setupDigit } from '@/lib/admin/setup-digit';
import { envName, parseEnvLinks } from '@/lib/admin/environment';
import type { AdminRole } from '@/lib/auth/types';
import { cn } from '@/lib/utils';


interface SidebarProps {
  readonly orgName?: string;
  readonly adminName: string;
  readonly adminEmail: string;
  readonly role: AdminRole;
  /** Server-decided position of the Setup item (fixed for this page load). */
  readonly setupPlacement: SetupPlacement;
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

/** One 30px rail row: nav links, the search button, and the env links all share
 *  this geometry so the rail reads as a single ruled column. */
const RAIL_ROW =
  'flex h-9 w-full items-center gap-2.5 rounded-[4px] px-2.5 text-sm ' +
  'text-sidebar-foreground transition-colors duration-100 ' +
  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sidebar-ring';

/** Paths whose visit should re-read the setup guide (home card and guide page). */
function isSetupRefreshPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === '/admin' || path === '/admin/setup';
}

/** Uppercase group label — the transform lives in the .u-label CSS class so the
 *  source strings stay sentence case (copy canon). */
const GROUP_LABEL = 'u-label px-2.5 pb-1 [color:var(--sidebar-foreground-dim)]';

export function Sidebar({
  orgName,
  adminName,
  adminEmail,
  role,
  setupPlacement,
  isMobileOpen,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const [isMobile, setIsMobile] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { count: unscheduledCount } = useUnscheduledCount();
  const { data: onboarding } = useOnboarding();
  const navGroups = navGroupsFor(setupPlacement);
  // One entry per NavItem.badge kind; every kind shares the visible/label/srLabel shape.
  const badges: Record<NonNullable<NavItem['badge']>, UnscheduledBadge> = useMemo(
    () => ({
      unscheduled: unscheduledBadge(unscheduledCount),
      setup: setupDigit({ data: onboarding }),
    }),
    [unscheduledCount, onboarding],
  );
  const envLinks =
    role === 'super_admin'
      ? parseEnvLinks(
          process.env.NEXT_PUBLIC_ENV_LINKS,
          envName(),
        )
      : [];

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

  // Read the setup guide once on mount, and again on landing on the home page
  // or the guide (the store throttles repeats and shares one request).
  const setupRefreshedOnMount = useRef(false);
  useEffect(() => {
    if (!setupRefreshedOnMount.current || isSetupRefreshPath(pathname)) {
      setupRefreshedOnMount.current = true;
      void refreshOnboarding();
    }
  }, [pathname]);

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
      const badge = item.badge ? badges[item.badge] : null;
      const showBadge = badge !== null && badge.visible;
      const isSetupDigit = item.badge === 'setup';
      return (
        <Link
          href={item.href}
          className={cn(
            'group/nav relative',
            RAIL_ROW,
            // Active: soft marker fill + a 2px marker edge drawn as an inset
            // box-shadow (no extra element, no layout shift).
            isActive &&
              'bg-[var(--sidebar-active)] font-semibold text-white shadow-[inset_3px_0_0_0_var(--sidebar-primary)] hover:bg-[var(--sidebar-active)] hover:text-white',
            collapsed && 'justify-center px-0',
          )}
        >
          <Icon
            className={cn(
              'size-4 shrink-0 transition-colors',
              isActive
                ? 'text-sidebar-primary'
                : '[color:var(--sidebar-foreground-dim)] group-hover/nav:text-sidebar-accent-foreground',
            )}
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
          {showBadge && !collapsed && isSetupDigit && (
            <span
              aria-label={badge.srLabel}
              className="ml-auto font-mono text-[11px] font-medium tabular-nums [color:var(--sidebar-foreground-dim)]"
            >
              {badge.label}
            </span>
          )}
          {showBadge && !collapsed && !isSetupDigit && (
            <span
              aria-label={badge.srLabel}
              className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] font-medium tabular-nums text-warning"
            >
              <span aria-hidden="true" className="text-[7px] leading-none">
                ◆
              </span>
              {badge.label}
            </span>
          )}
          {showBadge && collapsed && isSetupDigit && (
            <span
              aria-label={badge.srLabel}
              className="absolute right-1 top-0.5 font-mono text-[11px] font-medium tabular-nums [color:var(--sidebar-foreground-dim)]"
            >
              {badge.label}
            </span>
          )}
          {showBadge && collapsed && !isSetupDigit && (
            <span
              aria-label={badge.srLabel}
              className="absolute right-1.5 top-1.5 size-[6px] rotate-45 bg-warning"
            />
          )}
        </Link>
      );
    },
    [badges, isItemActive],
  );

  // Shared rail surface: a light sunken column separated from the canvas by a
  // hairline — no radius, no shadow, no gradient.
  const surfaceClass = 'bg-sidebar text-sidebar-foreground';

  // Mobile: overlay sidebar
  if (isMobile) {
    return (
      <>
        {isMobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-foreground/45"
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
            'fixed inset-y-0 left-0 z-50 w-[var(--sidebar-w,232px)] border-r border-sidebar-border transition-transform duration-200 motion-reduce:transition-none',
            surfaceClass,
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex h-16 items-center border-b border-sidebar-border px-4">
              <div className="flex flex-col gap-0.5">
                <BrandMark name={orgName} onDark />
                <EnvBadge />
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                onClick={onMobileClose}
                aria-label="Close navigation"
              >
                <X className="size-4" />
              </Button>
            </div>

            {/* Search button (mobile) */}
            <div className="px-3 pb-1 pt-3">
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('global-search:open'))
                }
                className={RAIL_ROW}
              >
                <Search className="size-4 shrink-0 [color:var(--sidebar-foreground-dim)]" />
                <span className="flex-1 text-left">Search</span>
                <kbd className="font-mono text-[11px] [color:var(--sidebar-foreground-dim)]">⌘K</kbd>
              </button>
            </div>

            <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
              {navGroups.map((group) => (
                <div key={group.heading} className="space-y-0.5">
                  <p className={GROUP_LABEL}>{group.heading}</p>
                  {group.items.map((item) => (
                    <div key={item.href}>{renderNavLink(item, false)}</div>
                  ))}
                </div>
              ))}
            </nav>

            <div className="border-t border-sidebar-border px-3 py-3">
              {envLinks.length > 0 && (
                <div className="mb-3 space-y-0.5">
                  <p className={GROUP_LABEL}>Environments</p>
                  {envLinks.map((link) => (
                    <a key={link.name} href={link.url} className={RAIL_ROW}>
                      {link.name}
                    </a>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2.5 rounded-[4px] bg-sidebar-accent px-2.5 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-[4px] bg-primary font-mono text-[11px] font-medium text-primary-foreground">
                  {initialsOf(adminName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{adminName}</p>
                  <p className="truncate text-xs [color:var(--sidebar-foreground-dim)]">{adminEmail}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="default"
                onClick={handleLogout}
                className="mt-1 w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
              >
                <LogOut className="size-4" />
                <span>Sign out</span>
              </Button>
            </div>
          </div>
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar — single TooltipProvider wraps the entire aside interior
  return (
    <aside
      className={cn(
        'shrink-0 border-r border-sidebar-border transition-[width] duration-200 motion-reduce:transition-none',
        surfaceClass,
        isCollapsed ? 'w-16' : 'w-[var(--sidebar-w,232px)]',
      )}
    >
      <TooltipProvider>
        <div className="flex h-full flex-col">
          {/* Logo + env badge */}
          <div
            className={cn(
              'flex h-16 items-center border-b border-sidebar-border px-4',
              isCollapsed && 'justify-center px-0',
            )}
          >
            {isCollapsed ? (
              <BrandMark compact onDark />
            ) : (
              <div className="flex flex-col gap-0.5">
                <BrandMark name={orgName} onDark />
                <EnvBadge />
              </div>
            )}
          </div>

          {/* Search button (desktop) */}
          <div className="px-3 pb-1 pt-3">
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent('global-search:open'))
                    }
                    className={cn(RAIL_ROW, 'justify-center px-0')}
                    aria-label="Search"
                  >
                    <Search className="size-4 shrink-0 [color:var(--sidebar-foreground-dim)]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Search ⌘K</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('global-search:open'))
                }
                className={RAIL_ROW}
              >
                <Search className="size-4 shrink-0 [color:var(--sidebar-foreground-dim)]" />
                <span className="flex-1 text-left">Search</span>
                <kbd className="font-mono text-[11px] [color:var(--sidebar-foreground-dim)]">⌘K</kbd>
              </button>
            )}
          </div>

          {/* Nav */}
          <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
            {navGroups.map((group, groupIndex) => (
              <div key={group.heading} className="space-y-0.5">
                {!isCollapsed && <p className={GROUP_LABEL}>{group.heading}</p>}
                {/* Collapsed: a short rule separates groups (not above the first). */}
                {isCollapsed && groupIndex > 0 && (
                  <div
                    className="mx-auto mb-1 h-px w-6 bg-sidebar-border"
                    aria-hidden="true"
                  />
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
          </nav>

          {/* Bottom section */}
          <div className="border-t border-sidebar-border px-3 py-3">
            {/* Env switcher (super_admin only, expanded only) */}
            {!isCollapsed && envLinks.length > 0 && (
              <div className="mb-3 space-y-0.5">
                <p className={GROUP_LABEL}>Environments</p>
                {envLinks.map((link) => (
                  <a key={link.name} href={link.url} className={RAIL_ROW}>
                    {link.name}
                  </a>
                ))}
              </div>
            )}

            {/* User info — expanded: full card; collapsed: initials chip with tooltip */}
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <span className="mx-auto mb-2 flex size-7 cursor-default items-center justify-center rounded-[4px] bg-primary font-mono text-[11px] font-medium text-primary-foreground">
                    {initialsOf(adminName)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="font-medium">{adminName}</p>
                  <p className="text-xs [color:var(--sidebar-foreground-dim)]">{adminEmail}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <div className="mb-1 flex items-center gap-2.5 rounded-[4px] bg-sidebar-accent px-2.5 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-[4px] bg-primary font-mono text-[11px] font-medium text-primary-foreground">
                  {initialsOf(adminName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{adminName}</p>
                  <p className="truncate text-xs [color:var(--sidebar-foreground-dim)]">{adminEmail}</p>
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
                'w-full text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground',
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
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleLogout}
                    className="w-full text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
                  >
                    <LogOut className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Sign out</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                variant="ghost"
                size="default"
                onClick={handleLogout}
                className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
              >
                <LogOut className="size-4" />
                <span>Sign out</span>
              </Button>
            )}
          </div>
        </div>
      </TooltipProvider>
    </aside>
  );
}
