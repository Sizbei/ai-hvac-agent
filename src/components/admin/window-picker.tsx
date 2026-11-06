'use client';

import { useState, useEffect, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  BOOKABLE_WINDOWS,
  WINDOW_LABELS,
  firstOpenDay,
  formatIsoDayShort,
  windowAvailability,
} from '@/lib/admin/create-request';
import type { OpenWindow } from '@/lib/admin/types';
import { windowHasEnded } from '@/lib/admin/window-ended';
import { cn } from '@/lib/utils';

const UNASSIGNED = '__unassigned__';
const AVAILABILITY_DAYS = 14;

/** Open bands for the next fortnight, fetched once `enabled` turns true. */
export function useAvailability(enabled: boolean) {
  const [days, setDays] = useState<readonly string[]>([]);
  const [windows, setWindows] = useState<readonly OpenWindow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      setFailed(false);
      try {
        const res = await fetch(`/api/admin/requests/availability?days=${AVAILABILITY_DAYS}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body?.success) {
          setDays(body.data.days as string[]);
          setWindows(body.data.windows as OpenWindow[]);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { days, windows, isLoading, failed };
}

export interface WindowPickerValue {
  /** Business-tz ISO day; '' = not chosen (the picker shows the first open day). */
  readonly isoDay: string;
  /** morning | afternoon | evening, or '' when no band is chosen. */
  readonly window: string;
  /** '' = unassigned. */
  readonly technicianId: string;
}

interface WindowPickerProps {
  /** null = nothing chosen yet. */
  readonly value: WindowPickerValue | null;
  readonly onChange: (value: WindowPickerValue) => void;
  /** Business-tz ISO days offered as chips. */
  readonly days: readonly string[];
  readonly availability: readonly OpenWindow[];
  /** Active technicians for the single-technician select; omit to hide it. */
  readonly technicians?: readonly { readonly id: string; readonly name: string }[];
  readonly isLoading?: boolean;
  readonly failed?: boolean;
  /** Prefix for element ids so two pickers on a page never collide. */
  readonly idPrefix?: string;
  /** Helper line shown while no window is chosen; null hides it. */
  readonly emptyHint?: string | null;
}

const EMPTY: WindowPickerValue = { isoDay: '', window: '', technicianId: '' };

/** Day chips + arrival-window chips ("7 of 8 open") + optional technician select. */
export function WindowPicker({
  value,
  onChange,
  days,
  availability,
  technicians,
  isLoading = false,
  failed = false,
  idPrefix = 'nr',
  emptyHint = 'Pick a window to schedule, or leave it unscheduled.',
}: WindowPickerProps) {
  const current = value ?? EMPTY;
  // Bands that are already over today are shown but can't be picked.
  const now = new Date();
  // Until a day is picked, default to the first day with an opening.
  const selectedDay = current.isoDay || firstOpenDay(days, availability, now);

  const techItems = useMemo(
    () => [
      { value: UNASSIGNED, label: 'Unassigned' },
      ...(technicians ?? []).map((t) => ({ value: t.id, label: t.name })),
    ],
    [technicians],
  );

  if (isLoading && days.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading availability…</p>;
  }
  if (failed) {
    return <p className="text-sm text-danger">Couldn’t load availability. Please try again.</p>;
  }

  return (
    <>
      <div className="space-y-1.5">
        <p id={`${idPrefix}-day-label`} className="text-sm font-medium">Day</p>
        <div
          role="radiogroup"
          aria-labelledby={`${idPrefix}-day-label`}
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        >
          {days.map((d) => {
            const open =
              BOOKABLE_WINDOWS.some((w) => !windowHasEnded(d, w, now)) &&
              availability.some((w) => w.day === d && w.available > 0);
            const selected = selectedDay === d;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange({ ...current, isoDay: d, window: '' })}
                className={cn(
                  'shrink-0 rounded-md border px-2.5 py-1.5 text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-ring',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : open
                      ? 'hover:bg-accent'
                      : 'text-muted-foreground',
                )}
              >
                {formatIsoDayShort(d)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <p id={`${idPrefix}-window-label`} className="text-sm font-medium">Arrival window</p>
        <div role="radiogroup" aria-labelledby={`${idPrefix}-window-label`} className="grid gap-1.5 sm:grid-cols-3">
          {BOOKABLE_WINDOWS.map((w) => {
            const counts = windowAvailability(availability, selectedDay, w);
            const ended = !!selectedDay && windowHasEnded(selectedDay, w, now);
            const selected = current.window === w && !ended;
            return (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!selectedDay || ended}
                onClick={() => onChange({ ...current, isoDay: selectedDay, window: w })}
                className={cn(
                  'flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50',
                  selected ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                )}
              >
                <span className="font-medium text-foreground">{WINDOW_LABELS[w]}</span>
                <span
                  className={cn('tabular-nums', ended || counts.available > 0 ? 'text-muted-foreground' : 'text-warning')}
                >
                  {ended
                    ? 'Already ended'
                    : counts.capacity === 0
                      ? 'No technicians working'
                      : `${counts.available} of ${counts.capacity} open`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {technicians && (
        <div className="space-y-1.5">
          <Label id={`${idPrefix}-tech-label`}>Technician</Label>
          <Select
            items={techItems}
            value={current.technicianId || UNASSIGNED}
            onValueChange={(v) =>
              onChange({ ...current, technicianId: !v || v === UNASSIGNED ? '' : v })
            }
          >
            <SelectTrigger className="w-full sm:w-64" aria-labelledby={`${idPrefix}-tech-label`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {techItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {!current.window && emptyHint && (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      )}
    </>
  );
}
