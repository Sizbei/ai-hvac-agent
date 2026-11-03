'use client';

import { useEffect, useRef, useState } from 'react';
import type { StaffRecord } from '@/lib/admin/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  businessIsoDate,
  businessWeekDates,
  formatBusinessTime,
} from '@/lib/admin/calendar-time';
import { formatCentsExact } from '@/lib/admin/money-format';
import {
  entryLabel,
  formatMinutes,
  groupEntriesByDay,
  type TimesheetEntry,
} from './timesheets-grouping';

interface TimesheetsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly staff: StaffRecord | null;
}

const LOAD_ERROR = "Couldn't load timesheets. Please try again.";
const RANGE_ERROR = 'Choose a range of 92 days or less, starting on or before the end date.';

function formatDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function TimesheetsDialog({ open, onClose, staff }: TimesheetsDialogProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState<readonly TimesheetEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const staffId = staff?.id ?? null;

  useEffect(() => {
    if (!open) return;
    const week = businessWeekDates(businessIsoDate(new Date()));
    setFrom(week[0]);
    setTo(week[6]);
    setEntries([]);
    setError(null);
  }, [open, staffId]);

  useEffect(() => {
    if (!open || !staffId || !from || !to) return;
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!(span >= 0 && span + 1 <= 92)) {
      setError(RANGE_ERROR);
      return;
    }
    const mine = ++seq.current;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/timesheets?technicianId=${staffId}&from=${from}&to=${to}`,
        );
        const body = (await res.json().catch(() => null)) as {
          data?: { entries?: TimesheetEntry[] };
        } | null;
        if (mine !== seq.current) return;
        if (!res.ok || !body?.data?.entries) {
          setError(LOAD_ERROR);
        } else {
          setEntries(body.data.entries);
        }
      } catch {
        if (mine === seq.current) setError(LOAD_ERROR);
      } finally {
        if (mine === seq.current) setIsLoading(false);
      }
    })();
  }, [open, staffId, from, to]);

  const groups = groupEntriesByDay(entries);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Timesheets</DialogTitle>
          <DialogDescription>
            {staff ? `Clocked time for ${staff.name}, by day.` : 'Clocked time, by day.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="timesheets-from">From</Label>
            <Input id="timesheets-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timesheets-to">To</Label>
            <Input id="timesheets-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        {error && <p className="text-sm text-danger-strong">{error}</p>}

        {isLoading && !error ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !error && groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No time recorded in this range.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.date} className="space-y-1">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-medium">{formatDay(group.date)}</h3>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMinutes(group.totalMinutes)} · {formatCentsExact(group.totalCostCents)}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Work</TableHead>
                    <TableHead>In</TableHead>
                    <TableHead>Out</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                    <TableHead className="text-right">Labor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{entryLabel(entry)}</TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {formatBusinessTime(new Date(entry.clockInAt))}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {entry.clockOutAt ? formatBusinessTime(new Date(entry.clockOutAt)) : 'Open'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {entry.minutes === null ? '—' : formatMinutes(entry.minutes)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {entry.laborCostCents === null ? '—' : formatCentsExact(entry.laborCostCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ))
        )}
      </DialogContent>
    </Dialog>
  );
}
