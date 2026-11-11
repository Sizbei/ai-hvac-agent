'use client';

import { Calendar, Receipt, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  customerInitials,
  customerCity,
  customerActivity,
} from '@/lib/admin/customer-display';
import { formatPhoneDisplay } from '@/lib/admin/contact-format';
import { lastSeenDotClass } from '@/lib/admin/status-colors';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import { SyncPill } from '@/components/admin/sync-pill';
import { customerNameLabel } from '@/lib/admin/customer-name-display';

interface CustomerPeopleCardsProps {
  readonly customers: readonly CustomerListRecord[];
  readonly onSelect: (id: string) => void;
  readonly selectedId: string | null;
}

function PeopleCard({
  customer,
  onSelect,
  active,
}: {
  readonly customer: CustomerListRecord;
  readonly onSelect: (id: string) => void;
  readonly active: boolean;
}) {
  const city = customerCity(customer.address);
  const sub =
    city ?? customer.email ?? formatPhoneDisplay(customer.phone) ?? 'No contact on file';
  const activity = customerActivity(customer);

  return (
    <button
      type="button"
      onClick={() => onSelect(customer.id)}
      aria-current={active ? 'true' : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border p-4 text-left transition-colors duration-100 motion-reduce:transition-none ${
        active
          ? 'border-marker bg-primary-soft shadow-[inset_2px_0_0_var(--marker)]'
          : 'border-border-strong bg-surface hover:bg-row-hover'
      }`}
    >
      {/* header: avatar + name — square 4 px sunken tile, mono initials */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-[4px] bg-surface-sunken font-mono text-[11px] font-medium text-muted-foreground"
          aria-hidden
        >
          {customerInitials(customer.name)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium">{customerNameLabel(customer.name)}</p>
            {customer.fieldpulseCustomerId && (
              <SyncPill source="fieldpulse" size="sm" />
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>

      {/* request / invoice / equipment counts */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Calendar className="size-3.5 text-foreground-faint" />
          <span className="font-mono font-medium tabular-nums text-foreground">
            {customer.requestCount}
          </span>
          request{customer.requestCount === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-1.5">
          <Receipt className="size-3.5 text-foreground-faint" />
          <span className="font-mono tabular-nums">{customer.invoiceCount}</span>
          invoice{customer.invoiceCount === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-1.5">
          <Wrench className="size-3.5 text-foreground-faint" />
          <span className="font-mono tabular-nums">{customer.equipmentCount}</span>
          equipment
        </span>
      </div>

      {/* footer: last seen + archived */}
      <div className="flex items-center justify-between border-t border-border pt-2.5 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            className={`size-1.5 rounded-[1px] ${lastSeenDotClass(activity.date)}`}
            aria-hidden
          />
          {activity.label}
        </span>
        {customer.archivedAt && (
          <Badge variant="outline" className="text-[10px]">
            Archived
          </Badge>
        )}
      </div>
    </button>
  );
}

/** The customers directory as a grid of "people" cards (initials avatar, booking
 * count, last-seen). Clicking a card opens the customer drawer. */
export function CustomerPeopleCards({
  customers,
  onSelect,
  selectedId,
}: CustomerPeopleCardsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {customers.map((customer) => (
        <PeopleCard
          key={customer.id}
          customer={customer}
          onSelect={onSelect}
          active={selectedId === customer.id}
        />
      ))}
    </div>
  );
}
