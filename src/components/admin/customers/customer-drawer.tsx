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
import { BookingHistoryList } from '@/components/admin/customers/booking-history-list';
import { customerInitials } from '@/lib/admin/customer-display';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import type { AgendaBooking } from '@/lib/admin/types';

interface CustomerDrawerProps {
  /** The customer to show, or null when the drawer is closed. */
  readonly customer: CustomerListRecord | null;
  readonly onClose: () => void;
}

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
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground"
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
              <BookingHistoryList
                bookings={bookings}
                isLoading={isLoading}
                error={error}
              />
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
