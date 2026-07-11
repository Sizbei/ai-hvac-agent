'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import type { AgendaBooking } from '@/lib/admin/types';

interface BookingHistoryListProps {
  readonly bookings: readonly AgendaBooking[] | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const STATUS_DOT: Record<string, string> = {
  pending: '#eab308',
  assigned: '#3b82f6',
  scheduled: '#06b6d4',
  in_progress: '#a855f7',
  on_hold: '#f97316',
  completed: '#16a34a',
  cancelled: '#9ca3af',
};

function BookingRow({ booking }: { readonly booking: AgendaBooking }) {
  const d = new Date(booking.bookedAt);
  const dot = STATUS_DOT[booking.status] ?? '#9ca3af';
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <div className="flex w-11 shrink-0 flex-col items-center">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          {MONTHS_SHORT[d.getUTCMonth()]}
        </span>
        <span className="text-sm font-bold leading-none tabular-nums">
          {d.getUTCDate()}
        </span>
        <span className="text-[9px] tabular-nums text-muted-foreground">
          {d.getUTCFullYear()}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {booking.issueType || 'Service request'}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {booking.referenceNumber}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: dot }}
          aria-hidden
        />
        <StatusBadge status={booking.status} />
      </span>
    </div>
  );
}

/**
 * A customer's booking history as a compact date-badge list. Shared by the
 * customers drawer and the full-profile bookings section so both render the same
 * rows. Handles its own loading / error / empty states.
 */
export function BookingHistoryList({
  bookings,
  isLoading,
  error,
}: BookingHistoryListProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-danger">{error}</p>;
  }
  if (!bookings || bookings.length === 0) {
    return <p className="text-sm text-muted-foreground">No bookings on record.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {bookings.map((b) => (
        <BookingRow key={b.id} booking={b} />
      ))}
    </div>
  );
}
