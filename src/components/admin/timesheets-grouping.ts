import { businessIsoDate } from '@/lib/admin/calendar-time';

export interface TimesheetEntry {
  readonly id: string;
  readonly kind: string;
  readonly clockInAt: string;
  readonly clockOutAt: string | null;
  readonly minutes: number | null;
  readonly laborCostCents: number | null;
  readonly referenceNumber: string | null;
  readonly appointmentNumber: number | null;
  readonly clockInMethod: string;
}

export interface TimesheetDayGroup {
  readonly date: string;
  readonly entries: readonly TimesheetEntry[];
  readonly totalMinutes: number;
  readonly totalCostCents: number;
}

/** 75 -> "1:15". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export function entryLabel(entry: TimesheetEntry): string {
  if (entry.kind === 'general' || !entry.referenceNumber) return 'General';
  return entry.appointmentNumber && entry.appointmentNumber > 1
    ? `${entry.referenceNumber} · Visit ${entry.appointmentNumber}`
    : entry.referenceNumber;
}

/** Groups by Eastern business day, newest day first; open entries add no totals. */
export function groupEntriesByDay(
  entries: readonly TimesheetEntry[],
): readonly TimesheetDayGroup[] {
  const byDay = new Map<string, TimesheetEntry[]>();
  for (const entry of entries) {
    const date = businessIsoDate(new Date(entry.clockInAt));
    byDay.set(date, [...(byDay.get(date) ?? []), entry]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, list]) => ({
      date,
      entries: list,
      totalMinutes: list.reduce((s, x) => s + (x.minutes ?? 0), 0),
      totalCostCents: list.reduce((s, x) => s + (x.laborCostCents ?? 0), 0),
    }));
}
