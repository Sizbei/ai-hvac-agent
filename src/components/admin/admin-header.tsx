'use client';

import { Menu, Thermometer } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AdminHeaderProps {
  readonly onMenuClick: () => void;
}

export function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  return (
    <header className="flex h-14 items-center gap-3 border-b bg-card px-4 md:hidden">
      <Button variant="ghost" size="icon" onClick={onMenuClick}>
        <Menu className="size-5" />
      </Button>
      <div className="flex items-center gap-2">
        <Thermometer className="size-5 text-primary" />
        <span className="text-base font-semibold">HVAC Dashboard</span>
      </div>
    </header>
  );
}
