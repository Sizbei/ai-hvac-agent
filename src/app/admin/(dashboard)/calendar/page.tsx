'use client';

import { useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useSchedulingCalendar,
  type CalendarView,
} from '@/hooks/use-scheduling-calendar';
import { useMonthCalendar } from '@/hooks/use-month-calendar';
import { InteractiveSchedulingCalendar } from '@/components/admin/calendar/interactive-scheduling-calendar';
import { MonthGrid } from '@/components/admin/calendar/month-grid';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { URGENCY_LEGEND, urgencyAccent } from '@/lib/admin/urgency-accent';

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

/** Shift a business-tz ISO date by whole months, clamping the day to the target
 * month's length (e.g. Jan 31 → Feb 28). Whole-month UTC date math, then clamp. */
function shiftMonth(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const targetMonthFirst = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const daysInTarget = new Date(
    Date.UTC(
      targetMonthFirst.getUTCFullYear(),
      targetMonthFirst.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  const day = Math.min(date.getUTCDate(), daysInTarget);
  return new Date(
    Date.UTC(
      targetMonthFirst.getUTCFullYear(),
      targetMonthFirst.getUTCMonth(),
      day,
    ),
  )
    .toISOString()
    .slice(0, 10);
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
  if (view === 'month') {
    return date.toLocaleDateString('en-US', {
      month: 'long',
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

/** A compact urgency color key shown beneath the calendar. */
function UrgencyLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium">Urgency:</span>
      {URGENCY_LEGEND.map(({ urgency, label }) => (
        <span key={urgency} className="flex items-center gap-1.5">
          <span
            className={`size-2.5 rounded-full ${urgencyAccent(urgency).dot}`}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

export default function CalendarPage() {
  const [date, setDate] = useState<string>(todayBusiness);
  const [view, setView] = useState<CalendarView>('day');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<CalendarStatus | null>(null);

  // Day/week share one hook; month uses a separate (lightweight) payload. Each
  // is enabled only for its active view so the inactive one doesn't poll.
  const isMonth = view === 'month';
  const { calendar, isLoading, error, refetch } = useSchedulingCalendar(
    date,
    view,
    !isMonth,
  );
  const {
    month,
    isLoading: monthLoading,
    error: monthError,
    refetch: refetchMonth,
  } = useMonthCalendar(date, isMonth);

  const isToday = date === todayBusiness();

  /** Step the date by the active view's unit. */
  function stepDate(direction: -1 | 1): void {
    setDate((d) =>
      isMonth
        ? shiftMonth(d, direction)
        : shiftDate(d, direction * (view === 'week' ? 7 : 1)),
    );
  }

  /** Jump to a specific business day in Day view (week header / month cell). */
  function pickDay(isoDay: string): void {
    setDate(isoDay);
    setView('day');
  }

  const activeError = isMonth ? monthError : error;
  const stepLabel = isMonth ? 'month' : view === 'week' ? 'week' : 'day';

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
            <Button
              variant={view === 'month' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('month')}
            >
              Month
            </Button>
          </div>

          {/* Date stepper */}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => stepDate(-1)}
            aria-label={`Previous ${stepLabel}`}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-44 text-center text-sm font-medium">
            {formatRangeLabel(date, view)}
          </div>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => stepDate(1)}
            aria-label={`Next ${stepLabel}`}
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

      {activeError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{activeError}</AlertDescription>
        </Alert>
      )}

      {status && (
        <Alert variant={status.tone === 'error' ? 'destructive' : 'default'}>
          <AlertCircle className="size-4" />
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}

      {isMonth ? (
        <MonthGrid
          month={month}
          isLoading={monthLoading}
          onSelect={setSelectedRequestId}
          onPickDay={pickDay}
        />
      ) : (
        <InteractiveSchedulingCalendar
          calendar={calendar}
          view={view}
          onSelect={setSelectedRequestId}
          onRefetch={refetch}
          onStatus={(message, tone) => setStatus({ message, tone })}
          isLoading={isLoading}
          onPickDay={pickDay}
        />
      )}

      <UrgencyLegend />

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={isMonth ? refetchMonth : refetch}
      />
    </div>
  );
}
