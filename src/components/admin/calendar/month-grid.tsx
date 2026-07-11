'use client';

import { Skeleton } from '@/components/ui/skeleton';
import {
  businessIsoDate,
  formatBusinessTime,
} from '@/lib/admin/calendar-time';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import type { MonthCalendar, MonthCalendarDay } from '@/lib/admin/types';
import type { DashboardRequest } from '@/lib/admin/types';
import { SyncPill } from '@/components/admin/sync-pill';

interface MonthGridProps {
  readonly month: MonthCalendar | null;
  readonly isLoading: boolean;
  /** Open the request detail sheet for a job chip. */
  readonly onSelect: (id: string) => void;
  /** Jump to a specific business day in Day view (day-cell click). */
  readonly onPickDay: (isoDay: string) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Max chips shown in a cell before collapsing the rest into "+N more". */
const MAX_CHIPS = 3;

/** The day-of-month number for a business-tz ISO date (no Date parsing drift —
 * the date is already business-tz, so the calendar day is the last path part). */
function dayOfMonth(isoDay: string): number {
  return Number(isoDay.slice(8, 10));
}

function JobChip({
  job,
  onSelect,
}: {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
}) {
  const accent = urgencyAccent(job.urgency);
  const time = job.arrivalWindowStart
    ? formatBusinessTime(new Date(job.arrivalWindowStart))
    : '';
  const label = job.customerName ?? job.referenceNumber;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(job.id);
      }}
      title={`${time} ${label}`}
      className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight transition-colors ${accent.chip}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${accent.dot}`} />
      {time && <span className="shrink-0 font-medium tabular-nums">{time}</span>}
      <span className="truncate">{label}</span>
      {job.syncedSource && (
        // ml-auto keeps the pill right-anchored so the truncating label gets
        // the remaining width (pre-SyncPill layout).
        <span className="ml-auto flex shrink-0">
          <SyncPill source={job.syncedSource} size="sm" />
        </span>
      )}
    </button>
  );
}

function MonthCell({
  cell,
  todayIso,
  onSelect,
  onPickDay,
}: {
  readonly cell: MonthCalendarDay;
  readonly todayIso: string;
  readonly onSelect: (id: string) => void;
  readonly onPickDay: (isoDay: string) => void;
}) {
  const isToday = cell.day === todayIso;
  const visible = cell.jobs.slice(0, MAX_CHIPS);
  const overflow = Math.max(cell.jobs.length - MAX_CHIPS, 0);

  return (
    <button
      type="button"
      onClick={() => onPickDay(cell.day)}
      title="Open this day"
      aria-label={`Open ${cell.day}${cell.jobs.length ? ` (${cell.jobs.length} jobs)` : ''}`}
      className={`flex min-h-24 flex-col gap-0.5 border-b border-r p-1 text-left align-top transition-colors hover:bg-muted/50 ${
        cell.inMonth ? 'bg-card' : 'bg-muted/30'
      }`}
    >
      <div className="flex justify-end">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
            isToday
              ? 'bg-primary font-semibold text-primary-foreground'
              : cell.inMonth
                ? 'text-foreground'
                : 'text-muted-foreground'
          }`}
        >
          {dayOfMonth(cell.day)}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {visible.map((job) => (
          <JobChip key={job.id} job={job} onSelect={onSelect} />
        ))}
        {overflow > 0 && (
          <span className="px-1 text-[11px] font-medium text-muted-foreground">
            +{overflow} more
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Read-only month overview (HCP-style): a 6×7 / 5×7 grid of business days, each
 * cell showing urgency-colored job chips (time + customer/ref) with a "+N more"
 * overflow. Clicking a chip opens the request detail; clicking a day cell jumps
 * into Day view. No drag-and-drop — scheduling happens in day/week.
 */
export function MonthGrid({
  month,
  isLoading,
  onSelect,
  onPickDay,
}: MonthGridProps) {
  if (isLoading && !month) {
    return <Skeleton className="h-[34rem] w-full" />;
  }
  if (!month || month.days.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No calendar data for this month.
      </div>
    );
  }

  const todayIso = businessIsoDate(new Date());

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="grid grid-cols-7 border-b bg-muted/40">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="border-r px-2 py-1.5 text-center text-xs font-semibold text-muted-foreground last:border-r-0"
          >
            {label}
          </div>
        ))}
      </div>
      {/* Border-collapse look via per-cell right/bottom borders; the wrapper's
          rounded overflow hides the trailing edges. */}
      <div className="grid grid-cols-7 [&>button:nth-child(7n)]:border-r-0">
        {month.days.map((cell) => (
          <MonthCell
            key={cell.day}
            cell={cell}
            todayIso={todayIso}
            onSelect={onSelect}
            onPickDay={onPickDay}
          />
        ))}
      </div>
    </div>
  );
}
