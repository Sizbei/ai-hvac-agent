'use client';

import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/admin/brand-mark';

interface AdminHeaderProps {
  readonly onMenuClick: () => void;
  /** Current page label shown between the hamburger and BrandMark on mobile,
   *  so users know their location when the sidebar is closed. */
  readonly title?: string;
  /** The org's display name — the same brand the desktop sidebar shows. */
  readonly orgName?: string;
  readonly logoUrl?: string | null;
}

export function AdminHeader({ onMenuClick, title, orgName, logoUrl }: AdminHeaderProps) {
  return (
    <header className="flex h-16 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur-sm md:hidden">
      <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open navigation">
        <Menu className="size-5" />
      </Button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <BrandMark name={orgName} logoUrl={logoUrl} className="min-w-0 max-w-[55%] [&_span]:truncate" />
    </header>
  );
}
