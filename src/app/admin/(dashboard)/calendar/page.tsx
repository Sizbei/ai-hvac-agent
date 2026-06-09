'use client';

import { useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useSchedulingCalendar,
  type CalendarView,
} from '@/hooks/use-scheduling-calendar';
import { InteractiveSchedulingCalendar } from '@/components/admin/calendar/interactive-scheduling-calendar';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** A transient banner the calendar surfaces after a reschedule (soft conflict
 * warning or a failure that triggered a rollback). */
interface CalendarStatus {
  readonly message: string;
  readonly tone: 'warning' | 'error';
}

/** Current business-tz day as YYYY-MM-DD. The calendar renders in Eastern, so
 * the date the stepper walks is a business-timezone calendar date. We read it
 * via Intl so the page anchors on the business day, not the browser's. */
function todayBusiness(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  // en-CA yields YYYY-MM-DD.
  return parts;
}

/** Shift a business-tz ISO date by whole days. Safe to do as UTC date math: we
 * only ever move whole calendar days, which is timezone-independent. */
function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatRangeLabel(isoDate: string, view: CalendarView): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  if (view === 'day') {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  // Week label: the Sunday-anchored week of this date.
  return `Week of ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;
}

export default function CalendarPage() {
  const [date, setDate] = useState<string>(todayBusiness);
  const [view, setView] = useState<CalendarView>('day');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<CalendarStatus | null>(null);

  const { calendar, isLoading, error, refetch } = useSchedulingCalendar(date, view);

  const step = view === 'week' ? 7 : 1;
  const isToday = date === todayBusiness();

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled jobs by technician, in Eastern time.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-lg border p-0.5">
            <Button
              variant={view === 'day' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('day')}
            >
              Day
            </Button>
            <Button
              variant={view === 'week' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('week')}
            >
              Week
            </Button>
          </div>

          {/* Date stepper */}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setDate((d) => shiftDate(d, -step))}
            aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-44 text-center text-sm font-medium">
            {formatRangeLabel(date, view)}
          </div>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setDate((d) => shiftDate(d, step))}
            aria-label={view === 'week' ? 'Next week' : 'Next day'}
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
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {status && (
        <Alert variant={status.tone === 'error' ? 'destructive' : 'default'}>
          <AlertCircle className="size-4" />
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}

      <InteractiveSchedulingCalendar
        calendar={calendar}
        view={view}
        onSelect={setSelectedRequestId}
        onRefetch={refetch}
        onStatus={(message, tone) => setStatus({ message, tone })}
        isLoading={isLoading}
      />

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </div>
  );
}
