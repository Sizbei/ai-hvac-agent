'use client';

import { useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDispatchBoard } from '@/hooks/use-dispatch-board';
import { DispatchColumn } from '@/components/admin/dispatch/dispatch-column';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Current UTC day as YYYY-MM-DD. The board is UTC-anchored end to end (arrival
 * windows are stored at UTC offsets), so the picker works in UTC too. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
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
  const [date, setDate] = useState<string>(todayUTC);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const { board, isLoading, error, refetch } = useDispatchBoard(date);

  const isToday = date === todayUTC();

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
            onClick={() => setDate(todayUTC())}
            disabled={isToday}
          >
            Today
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading && !board ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={`col-skeleton-${i}`} className="h-64 w-72 shrink-0" />
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
