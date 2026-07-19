'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useDispatchBoard } from '@/hooks/use-dispatch-board';
import { DispatchColumn } from '@/components/admin/dispatch/dispatch-column';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { businessIsoDate } from '@/lib/admin/calendar-time';

/** Current BUSINESS day as YYYY-MM-DD. Anchoring on the UTC day put the board
 * on tomorrow every evening after 8pm ET; the server buckets jobs by business
 * day too (getDispatchBoard), so picker and query agree. */
function todayBusiness(): string {
  return businessIsoDate(new Date());
}

/** Shift an ISO date (YYYY-MM-DD) by whole days, staying in UTC. */
function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function DispatchPage() {
  useEffect(() => { document.title = 'Dispatch · Spears Admin'; }, []);
  const [date, setDate] = useState<string>(todayBusiness);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const { board, isLoading, error, refetch } = useDispatchBoard(date);

  const isToday = date === todayBusiness();

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dispatch</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled jobs by technician for the day.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setDate((d) => shiftDate(d, -1))}
            aria-label="Previous day"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-40 text-center text-sm font-medium">
            {formatDayLabel(date)}
          </div>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setDate((d) => shiftDate(d, 1))}
            aria-label="Next day"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant={isToday ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setDate(todayBusiness())}
            disabled={isToday}
          >
            Today
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Retry loading dispatch board"
              onClick={() => void refetch()}
            >
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {isLoading && !board ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={`col-skeleton-${i}`} className="flex w-72 shrink-0 flex-col p-3">
              {/* Column header bar */}
              <div className="mb-3 flex items-center gap-2">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-4" />
              </div>
              {/* Stacked job-card bars */}
              <div className="space-y-2">
                {Array.from({ length: 3 }, (__, j) => (
                  <div key={j} className="rounded-lg border bg-card px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-8" />
                    </div>
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-44" />
                    <div className="flex gap-1.5 pt-0.5">
                      <Skeleton className="h-4 w-12 rounded-full" />
                      <Skeleton className="h-4 w-14 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          <DispatchColumn
            title="Unassigned"
            isUnassigned
            jobs={board?.unassigned ?? []}
            onSelect={setSelectedRequestId}
          />
          {(board?.columns ?? []).map((column) => (
            <DispatchColumn
              key={column.technicianId}
              title={column.technicianName}
              jobs={column.jobs}
              onSelect={setSelectedRequestId}
            />
          ))}
          {board && board.columns.length === 0 && (
            <p className="self-center text-sm text-muted-foreground">
              No active technicians. Add technicians under Staff.
            </p>
          )}
        </div>
      )}

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </div>
  );
}
