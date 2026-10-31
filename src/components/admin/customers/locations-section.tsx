'use client';

import { useEffect, useState } from 'react';
import { MapPin, MoreHorizontal } from 'lucide-react';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { CustomerLocation } from '@/lib/admin/location-queries';

interface LocationsSectionProps {
  readonly customerId: string;
}

/** Customer-page "Service locations" card: addresses, primary chip, make-primary menu. */
export function LocationsSection({ customerId }: LocationsSectionProps) {
  const [locations, setLocations] = useState<readonly CustomerLocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const reload = (): void => setVersion((v) => v + 1);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/customers/${customerId}/locations`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { data: { locations: readonly CustomerLocation[] } }) => {
        if (!active) return;
        setLocations(body.data.locations);
        setError(null);
      })
      .catch(() => {
        if (active) setError('Could not load service locations.');
      });
    return () => {
      active = false;
    };
  }, [customerId, version]);

  async function makePrimary(locationId: string): Promise<void> {
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/locations/${locationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(
          res.status === 409 && body?.error?.message
            ? body.error.message
            : 'Could not change the primary location.',
        );
        if (res.status === 409) reload();
        return;
      }
      reload();
    } catch {
      setError('Could not change the primary location.');
    }
  }

  return (
    <SectionCard
      title="Service locations"
      icon={MapPin}
      count={locations ? locations.length : undefined}
    >
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {locations === null && !error && (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      )}
      {locations?.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">No service locations yet.</p>
      )}
      {locations && locations.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {locations.map((loc) => (
            <li key={loc.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm text-foreground">
                  {loc.address ?? 'Address unavailable'}
                </span>
                {loc.label && <span className="text-xs text-muted-foreground">{loc.label}</span>}
                {loc.isPrimary && <ContextBadge variant="info" label="Primary" />}
                {loc.zone && <span className="text-xs text-muted-foreground">{loc.zone}</span>}
              </div>
              {!loc.isPrimary && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label="Location actions" />}
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void makePrimary(loc.id)}>
                      Make primary
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
