'use client';

import { Calendar, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  customerInitials,
  customerCity,
  lastSeenLabel,
  lastSeenTone,
} from '@/lib/admin/customer-display';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import { SyncPill } from '@/components/admin/sync-pill';

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
  const sub = city ?? customer.email ?? customer.phone ?? 'No contact on file';

  return (
    <button
      type="button"
      onClick={() => onSelect(customer.id)}
      aria-pressed={active}
      className={`flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-muted-foreground/40 hover:shadow-md ${
        active ? 'border-primary ring-1 ring-primary' : ''
      }`}
    >
      {/* header: avatar + name */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
          aria-hidden
        >
          {customerInitials(customer.name)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate font-semibold">{customer.name ?? 'Unknown'}</p>
            {customer.fieldpulseCustomerId && (
              <SyncPill source="fieldpulse" size="sm" />
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>

      {/* booking count */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Calendar className="size-3.5" />
          <span className="font-semibold text-foreground tabular-nums">
            {customer.requestCount}
          </span>
          booking{customer.requestCount === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-1.5">
          <Wrench className="size-3.5" />
          <span className="tabular-nums">{customer.equipmentCount}</span>
        </span>
      </div>

      {/* footer: last seen + archived */}
      <div className="flex items-center justify-between border-t border-dashed pt-2.5 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: lastSeenTone(customer.lastServiceDate) }}
            aria-hidden
          />
          {lastSeenLabel(customer.lastServiceDate)}
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
