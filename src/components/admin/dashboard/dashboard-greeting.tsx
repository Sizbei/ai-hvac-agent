'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Warm dashboard header: a time-of-day greeting (resolved on the client to the
 * viewer's local time) + today's date, with a single cyan quick-action into the
 * requests surface. No fabricated stats here.
 */
export function DashboardGreeting({ name }: { readonly name?: string }) {
  // Render a stable placeholder on the server, then fill in local time after
  // mount to avoid hydration mismatch on the time-dependent greeting/date.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

  const greeting = now ? greetingForHour(now.getHours()) : 'Welcome';
  const firstName = name?.trim().split(/\s+/)[0];
  const dateLabel = now
    ? now.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : '';

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-heading text-2xl font-bold leading-tight tracking-tight sm:text-[28px]">
          {greeting}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-1 flex min-h-5 items-center gap-1.5 text-sm text-muted-foreground">
          {dateLabel && (
            <>
              <Clock className="size-3.5" />
              {dateLabel}
            </>
          )}
        </p>
      </div>
      <Button size="lg" render={<Link href="/admin/requests" />}>
        <Plus className="size-4" />
        New request
      </Button>
    </div>
  );
}
