'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StaffRecord } from '@/lib/admin/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  defaultRemovesCapacity,
  type ShiftKind,
  type ShiftRecord,
} from '@/lib/admin/shift-types';
import { expandDailyShifts, firstUnsavedDay } from '@/lib/admin/time-off-expand';
import {
  businessIsoDate,
  formatBusinessTime,
} from '@/lib/admin/calendar-time';

interface TimeOffDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly staff: StaffRecord | null;
}

const KIND_OPTIONS = [
  { value: 'time_off', label: 'Time off' },
  { value: 'on_call', label: 'On call' },
  { value: 'non_job', label: 'Non-job event' },
] as const;

const KIND_LABEL: Record<ShiftKind, string> = {
  time_off: 'Time off',
  on_call: 'On call',
  non_job: 'Non-job event',
};

const SAVE_ERROR = "Couldn't save the time off. Please try again.";
const LOAD_ERROR = "Couldn't load upcoming time off.";
const REMOVE_ERROR = "Couldn't remove that entry. Please try again.";
const LOOKAHEAD_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatRange(shift: ShiftRecord): string {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const startDay = businessIsoDate(start);
  const endDay = businessIsoDate(end);
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const times = `${formatBusinessTime(start)} to ${formatBusinessTime(end)}`;
  return startDay === endDay
    ? `${day(startDay)}, ${times}`
    : `${day(startDay)} to ${day(endDay)}`;
}

export function TimeOffDialog({ open, onClose, staff }: TimeOffDialogProps) {
  const [kind, setKind] = useState<ShiftKind>('time_off');
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('17:00');
  const [removesCapacity, setRemovesCapacity] = useState(true);
  const [capacityTouched, setCapacityTouched] = useState(false);
  const [shifts, setShifts] = useState<readonly ShiftRecord[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const staffId = staff?.id ?? null;
  const loadSeq = useRef(0);

  const loadShifts = useCallback(async (): Promise<void> => {
    if (!staffId) return;
    const seq = ++loadSeq.current;
    const from = new Date();
    const to = new Date(from.getTime() + LOOKAHEAD_DAYS * DAY_MS);
    try {
      const res = await fetch(
        `/api/admin/technicians/${staffId}/shifts?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      );
      if (!res.ok) {
        if (seq === loadSeq.current) setListError(LOAD_ERROR);
        return;
      }
      const body = (await res.json()) as {
        data?: { shifts?: ShiftRecord[] };
      };
      if (seq !== loadSeq.current) return;
      setShifts(body.data?.shifts ?? []);
      setListError(null);
    } catch {
      if (seq === loadSeq.current) setListError(LOAD_ERROR);
    }
  }, [staffId]);

  useEffect(() => {
    if (!open) return;
    const today = businessIsoDate(new Date());
    setKind('time_off');
    setTitle('');
    setStartDate(today);
    setEndDate(today);
    setStartTime('08:00');
    setEndTime('17:00');
    setRemovesCapacity(defaultRemovesCapacity('time_off'));
    setCapacityTouched(false);
    setError(null);
    setConfirmId(null);
    setShifts([]);
    setListError(null);
    void loadShifts();
  }, [open, loadShifts]);

  function handleKindChange(next: ShiftKind): void {
    setKind(next);
    if (!capacityTouched) setRemovesCapacity(defaultRemovesCapacity(next));
  }

  const spans = expandDailyShifts(startDate, endDate, startTime, endTime);
  const canSave = staffId !== null && spans.length > 0 && !isSaving;

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!staffId || spans.length === 0) return;
    setIsSaving(true);
    setError(null);
    let saved = 0;
    const failMessage = (): string =>
      saved > 0
        ? `Saved ${saved} of ${spans.length} days. Couldn't save the rest. Try again from ${firstUnsavedDay(startDate, saved)}.`
        : SAVE_ERROR;
    try {
      for (const span of spans) {
        const res = await fetch(`/api/admin/technicians/${staffId}/shifts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            ...(title.trim() ? { title: title.trim() } : {}),
            startsAt: span.startsAt,
            endsAt: span.endsAt,
            removesCapacity,
          }),
        });
        if (!res.ok) {
          setError(failMessage());
          if (saved > 0) setStartDate(firstUnsavedDay(startDate, saved));
          return;
        }
        saved += 1;
      }
      setTitle('');
    } catch {
      setError(failMessage());
      if (saved > 0) setStartDate(firstUnsavedDay(startDate, saved));
    } finally {
      setIsSaving(false);
      await loadShifts();
    }
  }

  async function handleRemove(id: string): Promise<void> {
    if (!staffId) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/technicians/${staffId}/shifts/${id}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 404) setError(REMOVE_ERROR);
    } catch {
      setError(REMOVE_ERROR);
    } finally {
      setConfirmId(null);
      await loadShifts();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Time off</DialogTitle>
          <DialogDescription>
            {staff
              ? `Schedule time away or on-call coverage for ${staff.name}.`
              : 'Schedule time away or on-call coverage.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4">
          <SegmentedControl
            aria-label="Kind"
            options={KIND_OPTIONS}
            value={kind}
            onChange={handleKindChange}
          />

          <div className="space-y-2">
            <Label htmlFor="timeoff-title">Title (optional)</Label>
            <Input
              id="timeoff-title"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Vacation, training, weekend rotation"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="timeoff-start-date">Start date</Label>
              <Input
                id="timeoff-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeoff-start-time">Start time</Label>
              <Input
                id="timeoff-start-time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeoff-end-date">End date</Label>
              <Input
                id="timeoff-end-date"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeoff-end-time">End time</Label>
              <Input
                id="timeoff-end-time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
          {spans.length > 1 && (
            <p className="text-xs text-muted-foreground">
              Creates {spans.length} daily entries with the same times.
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="timeoff-capacity">Removes capacity</Label>
            <Switch
              id="timeoff-capacity"
              checked={removesCapacity}
              onCheckedChange={(v) => {
                setRemovesCapacity(v);
                setCapacityTouched(true);
              }}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Upcoming</h3>
          {listError && <p className="text-sm text-destructive">{listError}</p>}
          {!listError && shifts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing scheduled in the next 90 days.
            </p>
          )}
          <ul className="space-y-1.5">
            {shifts.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {s.title || KIND_LABEL[s.kind]}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {KIND_LABEL[s.kind]} · {formatRange(s)}
                  </div>
                </div>
                {confirmId === s.id ? (
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleRemove(s.id)}
                    >
                      Confirm
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmId(null)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Remove ${s.title || KIND_LABEL[s.kind]}`}
                    onClick={() => setConfirmId(s.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={!canSave}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>

      </DialogContent>
    </Dialog>
  );
}
