'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBusinessTime } from '@/lib/admin/calendar-time';
import type { RescheduleConflictDetail } from '@/hooks/use-reschedule-job';

interface ConflictDialogProps {
  /** The blocked move's conflict detail, or null when no dialog is open. */
  readonly conflict: RescheduleConflictDetail | null;
  /** Server's human message for the conflict (overlap / out-of-hours / both). */
  readonly message: string;
  /** Whether the override (schedule-anyway) request is in flight. */
  readonly isSubmitting: boolean;
  /** Commit the move despite the conflict (sends override:true). */
  readonly onOverride: () => void;
  /** Abandon the move (rolls the board back). */
  readonly onCancel: () => void;
}

/** A clash row, rendered in the business timezone (Eastern) — never the
 * viewer's local zone, matching the calendar grid. */
function ConflictRow({
  referenceNumber,
  arrivalWindowStart,
  arrivalWindowEnd,
}: {
  readonly referenceNumber: string;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
}) {
  const start = new Date(arrivalWindowStart);
  const end = new Date(arrivalWindowEnd);
  const window =
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
      ? 'time unknown'
      : `${formatBusinessTime(start)} – ${formatBusinessTime(end)}`;
  return (
    <li className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm">
      <Clock className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium tabular-nums">{referenceNumber}</span>
      <span className="ml-auto text-xs text-muted-foreground">{window}</span>
    </li>
  );
}

/**
 * The HARD-conflict warning the server's 409 surfaces (S4). The drop has been
 * rolled back optimistically; this dialog lets the dispatcher CANCEL (leave it
 * rolled back) or SCHEDULE ANYWAY (re-POST with override:true). The client is
 * never the only gate — this only re-asks the server; the server re-checks and
 * commits the override. Renders nothing when `conflict` is null.
 */
export function ConflictDialog({
  conflict,
  message,
  isSubmitting,
  onOverride,
  onCancel,
}: ConflictDialogProps) {
  const open = conflict !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSubmitting) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            Scheduling conflict
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>

        {conflict && conflict.conflicts.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Overlapping job{conflict.conflicts.length === 1 ? '' : 's'}:
            </p>
            <ul className="space-y-1">
              {conflict.conflicts.map((job) => (
                <ConflictRow
                  key={job.id}
                  referenceNumber={job.referenceNumber}
                  arrivalWindowStart={job.arrivalWindowStart}
                  arrivalWindowEnd={job.arrivalWindowEnd}
                />
              ))}
            </ul>
          </div>
        )}

        {conflict?.outsideAvailability && (
          <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            This window falls outside the technician&apos;s configured working
            hours.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onOverride}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Scheduling…' : 'Schedule anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
