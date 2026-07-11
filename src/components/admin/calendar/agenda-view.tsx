'use client';

import { CalendarClock, MapPin, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import {
  toBusinessWallClock,
  businessIsoDate,
  formatBusinessTime,
} from '@/lib/admin/calendar-time';
import type { AgendaBooking } from '@/lib/admin/types';

interface AgendaViewProps {
  readonly bookings: readonly AgendaBooking[];
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
  readonly onSelect: (id: string) => void;
  readonly onLoadOlder: () => void;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Solid date-badge color by status. Urgency is uniformly "medium" on imported
 * data, so status is what actually carries scannable meaning here. Mirrors the
 * StatusBadge hues. */
const STATUS_DOT: Record<string, string> = {
  pending: 'bg-yellow-500',
  assigned: 'bg-blue-500',
  scheduled: 'bg-cyan-500',
  in_progress: 'bg-purple-500',
  on_hold: 'bg-orange-500',
  completed: 'bg-green-600',
  cancelled: 'bg-gray-400',
};

interface Row {
  readonly kind: 'month' | 'today' | 'booking';
  readonly key: string;
  readonly label?: string;
  readonly count?: number;
  readonly booking?: AgendaBooking;
}

/** Flatten the feed into render rows: a month header when the business-tz month
 * changes, a "Today" rule before the first row at/after today, then bookings. */
function buildRows(bookings: readonly AgendaBooking[]): readonly Row[] {
  const todayIso = businessIsoDate(new Date());
  const rows: Row[] = [];
  let curMonth = '';
  let todayShown = false;
  // Only draw the "Today" rule as a boundary BETWEEN future and today/past rows —
  // i.e. once we've actually seen a future booking above. In a past-only history
  // (the common case) there's nothing to divide, so no rule.
  let sawFuture = false;

  // Per-month counts for the header.
  const monthCount = new Map<string, number>();
  for (const b of bookings) {
    const w = toBusinessWallClock(new Date(b.bookedAt));
    const mk = `${w.year}-${w.month}`;
    monthCount.set(mk, (monthCount.get(mk) ?? 0) + 1);
  }

  for (const b of bookings) {
    const w = toBusinessWallClock(new Date(b.bookedAt));
    const mk = `${w.year}-${w.month}`;
    if (mk !== curMonth) {
      curMonth = mk;
      rows.push({
        kind: 'month',
        key: `m-${mk}`,
        label: `${MONTHS[w.month - 1]} ${w.year}`,
        count: monthCount.get(mk),
      });
    }
    const iso = businessIsoDate(new Date(b.bookedAt));
    const isFuture = iso > todayIso;
    if (!todayShown && !isFuture && sawFuture) {
      todayShown = true;
      rows.push({ kind: 'today', key: 't-rule' });
    }
    if (isFuture) sawFuture = true;
    rows.push({ kind: 'booking', key: b.id, booking: b });
  }
  return rows;
}

function AgendaRow({
  booking,
  onSelect,
}: {
  readonly booking: AgendaBooking;
  readonly onSelect: (id: string) => void;
}) {
  const when = new Date(booking.bookedAt);
  const w = toBusinessWallClock(when);
  const dot = STATUS_DOT[booking.status] ?? 'bg-gray-400';

  return (
    <button
      type="button"
      onClick={() => onSelect(booking.id)}
      className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-muted-foreground/40 hover:bg-muted/40"
    >
      {/* date badge */}
      <div className="flex w-12 shrink-0 flex-col items-center">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {MONTHS_SHORT[w.month - 1]}
        </span>
        <span className="text-lg font-bold leading-none tabular-nums">{w.day}</span>
        <span className={`mt-1 size-1.5 rounded-full ${dot}`} aria-hidden />
      </div>

      {/* body */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {booking.issueType || 'Service request'}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">
            {booking.customerName ?? 'Unknown customer'}
          </span>
          {booking.address && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <MapPin className="size-3 shrink-0" />
                <span className="truncate">{booking.address}</span>
              </span>
            </>
          )}
        </div>
      </div>

      {/* right rail */}
      <div className="flex shrink-0 items-center gap-2">
        {booking.isScheduled ? (
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {formatBusinessTime(when)}
          </span>
        ) : (
          <span className="hidden text-[11px] italic text-muted-foreground sm:inline">
            no window
          </span>
        )}
        <StatusBadge status={booking.status} />
        {booking.syncedSource && (
          <span className="rounded border bg-violet-50 px-1.5 py-px text-[9px] font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
            {booking.syncedSource === 'fieldpulse' ? 'FP' : 'HCP'}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * The agenda view: every booking (past + upcoming) as one chronological,
 * month-grouped list — newest first, with a "Today" rule and a load-older
 * control. Ported from the reference agenda layout, rendered in the admin theme.
 * Read-only; clicking a row opens the request detail sheet.
 */
export function AgendaView({
  bookings,
  isLoading,
  isLoadingMore,
  hasMore,
  error,
  onSelect,
  onLoadOlder,
}: AgendaViewProps) {
  if (isLoading && bookings.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <Inbox className="mx-auto size-8 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium">No bookings yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Bookings will appear here as they come in.
        </p>
      </div>
    );
  }

  const rows = buildRows(bookings);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          if (row.kind === 'month') {
            return (
              <div
                key={row.key}
                className="mt-4 flex items-baseline gap-2 first:mt-0"
              >
                <h2 className="text-base font-semibold text-primary">{row.label}</h2>
                <span className="text-xs text-muted-foreground">
                  {row.count} booking{row.count === 1 ? '' : 's'}
                </span>
              </div>
            );
          }
          if (row.kind === 'today') {
            return (
              <div key={row.key} className="my-1 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-danger">
                  Today
                </span>
                <span className="h-px flex-1 bg-danger/30" />
              </div>
            );
          }
          return (
            <AgendaRow key={row.key} booking={row.booking!} onSelect={onSelect} />
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-center text-sm text-danger">{error}</p>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadOlder}
            disabled={isLoadingMore}
          >
            <CalendarClock className="size-4" />
            {isLoadingMore ? 'Loading…' : 'Load older bookings'}
          </Button>
        </div>
      )}
    </div>
  );
}
