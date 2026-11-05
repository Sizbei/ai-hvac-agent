'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { jobClockLine } from '@/lib/tech/clock-display';

/**
 * Read-only "Time on this job". Status taps are the only job clock (I've
 * arrived / Working open an entry; Pause, Hold, Done and Close out close it),
 * so there is no Clock in / Clock out button here.
 */
export function JobTimeCard({
  openSince,
  totalMinutes,
  loaded,
}: {
  readonly openSince: string | null;
  readonly totalMinutes: number;
  readonly loaded: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick while on the clock; minutes are the smallest unit shown.
  useEffect(() => {
    if (!openSince) return;
    const tick = () => setNowMs(Date.now());
    const first = setTimeout(tick, 0); // the entry may have opened after mount
    const t = setInterval(tick, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [openSince]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Time on this job</CardTitle>
      </CardHeader>
      <CardContent>
        {loaded ? (
          <p className={`text-[15px] ${openSince ? 'text-foreground' : 'text-muted-foreground'}`}>
            {jobClockLine({ openSince, totalMinutes, nowMs })}
          </p>
        ) : (
          <Skeleton className="h-5 w-56" />
        )}
      </CardContent>
    </Card>
  );
}
