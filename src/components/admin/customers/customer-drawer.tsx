'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Phone, Mail, MapPin, ArrowUpRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import { customerInitials, customerHue } from '@/lib/admin/customer-display';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import type { AgendaBooking } from '@/lib/admin/types';

interface CustomerDrawerProps {
  /** The customer to show, or null when the drawer is closed. */
  readonly customer: CustomerListRecord | null;
  readonly onClose: () => void;
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

function ContactRow({
  icon: Icon,
  value,
  href,
}: {
  readonly icon: typeof Phone;
  readonly value: string | null;
  readonly href?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {value ? (
        href ? (
          <a href={href} className="truncate text-primary hover:underline">
            {value}
          </a>
        ) : (
          <span className="truncate">{value}</span>
        )
      ) : (
        <span className="italic text-muted-foreground">—</span>
      )}
    </div>
  );
}

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
      <span className="flex items-center gap-1.5 shrink-0">
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
 * Slide-in drawer for a customer: avatar + name header, contact block, and their
 * full booking history (fetched from /api/admin/customers/[id]/bookings — sourced
 * from service_requests so imported customers show real bookings). A link opens
 * the full profile page. Ported from the reference "people" drawer.
 */
export function CustomerDrawer({ customer, onClose }: CustomerDrawerProps) {
  const router = useRouter();
  const [bookings, setBookings] = useState<readonly AgendaBooking[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customerId = customer?.id ?? null;

  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setBookings(null);
    setError(null);
    setIsLoading(true);
    fetch(`/api/admin/customers/${customerId}/bookings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { data: { bookings: readonly AgendaBooking[] } }) => {
        if (active) setBookings(body.data.bookings);
      })
      .catch(() => {
        if (active) setError('Could not load booking history.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  return (
    <Sheet
      open={customer != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:w-[440px] sm:max-w-[440px]"
      >
        {customer && (
          <>
            <SheetHeader className="space-y-0">
              <SheetTitle className="flex items-center gap-3">
                <div
                  className="flex size-12 shrink-0 items-center justify-center rounded-full text-base font-bold text-white"
                  style={{ backgroundColor: customerHue(customer.id) }}
                  aria-hidden
                >
                  {customerInitials(customer.name)}
                </div>
                <span className="min-w-0">
                  <span className="block truncate text-lg font-semibold">
                    {customer.name ?? 'Unknown'}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {customer.requestCount} booking
                    {customer.requestCount === 1 ? '' : 's'} on record
                  </span>
                </span>
              </SheetTitle>
            </SheetHeader>

            {/* contact */}
            <div className="mt-5 flex flex-col gap-2.5">
              <ContactRow
                icon={Phone}
                value={customer.phone}
                href={customer.phone ? `tel:${customer.phone}` : undefined}
              />
              <ContactRow
                icon={Mail}
                value={customer.email}
                href={customer.email ? `mailto:${customer.email}` : undefined}
              />
              <ContactRow icon={MapPin} value={customer.address} />
            </div>

            {/* booking history */}
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Booking history
              </h3>
              {isLoading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-lg" />
                  ))}
                </div>
              ) : error ? (
                <p className="text-sm text-danger">{error}</p>
              ) : bookings && bookings.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {bookings.map((b) => (
                    <BookingRow key={b.id} booking={b} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No bookings on record.
                </p>
              )}
            </div>

            <div className="mt-auto pt-6">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => router.push(`/admin/customers/${customer.id}`)}
              >
                Open full profile
                <ArrowUpRight className="size-4" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
