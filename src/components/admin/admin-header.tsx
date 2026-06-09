'use client';

import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/admin/brand-mark';

interface AdminHeaderProps {
  readonly onMenuClick: () => void;
}

export function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  return (
    <header className="flex h-16 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur-sm md:hidden">
      <Button variant="ghost" size="icon" onClick={onMenuClick}>
        <Menu className="size-5" />
      </Button>
      <BrandMark />
    </header>
  );
}
