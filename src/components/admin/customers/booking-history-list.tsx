'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import { REQUEST_STATUS_DOT, REQUEST_STATUS_DOT_DEFAULT } from '@/lib/admin/status-colors';
import type { AgendaBooking } from '@/lib/admin/types';
import { issueTypeLabel } from '@/lib/admin/display-labels';
import { bookingDateParts } from '@/lib/admin/customer-display';

interface BookingHistoryListProps {
  readonly bookings: readonly AgendaBooking[] | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

function BookingRow({ booking }: { readonly booking: AgendaBooking }) {
  const d = bookingDateParts(booking.bookedAt);
  const dotClass = REQUEST_STATUS_DOT[booking.status] ?? REQUEST_STATUS_DOT_DEFAULT;
  const issue = issueTypeLabel(booking.issueType);
  return (
    <Link
      href={`/admin/requests?request=${booking.id}`}
      aria-label={`Open request ${booking.referenceNumber}: ${issue}`}
      className="flex items-center gap-3 rounded-[3px] bg-surface-sunken px-3 py-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex w-11 shrink-0 flex-col items-center font-mono tabular-nums">
        <span className="text-[10px] font-semibold text-muted-foreground">{d.month}</span>
        <span className="text-sm font-medium leading-none">{d.day}</span>
        <span className="text-[9px] text-muted-foreground">{d.year}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{issue}</p>
        <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">{booking.referenceNumber}</span>
          <span className="truncate">{booking.assignedToName ?? 'No technician assigned'}</span>
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={`size-1.5 rounded-[1px] ${dotClass}`}
          aria-hidden
        />
        <StatusBadge status={booking.status} />
      </span>
    </Link>
  );
}

/**
 * A customer's request history as a compact date-badge list; each row opens
 * the request on /admin/requests. Shared by the
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
          <Skeleton key={i} className="h-12 w-full rounded-[3px]" />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-danger">{error}</p>;
  }
  if (!bookings || bookings.length === 0) {
    return <p className="text-sm text-muted-foreground">No requests on record.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {bookings.map((b) => (
        <BookingRow key={b.id} booking={b} />
      ))}
    </div>
  );
}
