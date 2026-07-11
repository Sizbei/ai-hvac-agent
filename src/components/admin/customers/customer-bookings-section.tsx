'use client';

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BookingHistoryList } from '@/components/admin/customers/booking-history-list';
import type { AgendaBooking } from '@/lib/admin/types';

interface CustomerBookingsSectionProps {
  readonly customerId: string;
}

/**
 * The full-profile "Bookings" card: a customer's real bookings from
 * service_requests (the service_history table is empty for imported jobs, so the
 * legacy Service History card shows nothing). Fetches the same endpoint as the
 * customers drawer and renders the shared history list.
 */
export function CustomerBookingsSection({
  customerId,
}: CustomerBookingsSectionProps) {
  const [bookings, setBookings] = useState<readonly AgendaBooking[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    fetch(`/api/admin/customers/${customerId}/bookings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { data: { bookings: readonly AgendaBooking[] } }) => {
        if (active) setBookings(body.data.bookings);
      })
      .catch(() => {
        if (active) setError('Could not load bookings.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4" />
          Bookings{bookings ? ` (${bookings.length})` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <BookingHistoryList
          bookings={bookings}
          isLoading={isLoading}
          error={error}
        />
      </CardContent>
    </Card>
  );
}
