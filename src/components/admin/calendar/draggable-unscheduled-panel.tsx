'use client';

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import {
  dragJobId,
  UNSCHEDULED_DROP_ID,
  type DragJobData,
  type UnscheduledDropZoneData,
} from '@/lib/admin/calendar-dnd';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import { DASHBOARD_LIST_LIMIT, type DashboardRequest } from '@/lib/admin/types';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface DraggableUnscheduledPanelProps {
  /** Jobs not yet placed: no technician and/or no arrival window. */
  readonly jobs: readonly DashboardRequest[];
  readonly isLoading: boolean;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}

function reason(job: DashboardRequest): string {
  const noTech = !job.assignedToName;
  const noWindow = !job.arrivalWindowStart;
  if (noTech && noWindow) return 'No technician · no window';
  if (noTech) return 'No technician';
  return 'No arrival window';
}

/** One draggable row in the queue. Dragging it onto a calendar band reschedules
 * it (the reschedule endpoint sets the window; it does NOT assign a tech, so a
 * dropped-into-a-tech-lane card still needs a separate assignment). */
function UnscheduledRow({
  job,
  onSelect,
  disabled,
}: {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}) {
  const data: DragJobData = {
    kind: 'job',
    requestId: job.id,
    currentStartIso: job.arrivalWindowStart,
    label: `${job.customerName ?? 'Unknown customer'}, ${job.referenceNumber}`,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragJobId(job.id),
    data,
    disabled,
  });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      type="button"
      onClick={() => onSelect(job.id)}
      // min-h-9 keeps the drag target above the 32px floor the density spec
      // sets for calendar/dispatch, whatever the row's content height.
      className={`w-full touch-none rounded-sm border border-border border-l-[3px] ${urgencyAccent(job.urgency).bar} min-h-9 bg-surface-raised px-3 py-2 text-left transition-colors hover:bg-row-hover ${
        isDragging ? 'opacity-40' : ''
      } ${disabled ? 'cursor-progress' : 'cursor-grab active:cursor-grabbing'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium">
          {job.customerName ?? 'Unknown'}
        </span>
        {job.isAfterHours && (
          <span
            title="After hours"
            className="inline-flex shrink-0 items-center rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[10px] font-medium text-warning-strong"
          >
            After-hrs
          </span>
        )}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {issueTypeLabel(job.issueType)} ·{' '}
        <span className="font-mono">{job.referenceNumber}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <UrgencyBadge urgency={job.urgency} />
        <StatusBadge status={job.status} />
        <span className="ml-auto text-[10px] font-medium text-warning-strong">
          {reason(job)}
        </span>
      </div>
    </button>
  );
}

/**
 * The "to place" queue, with each card now @dnd-kit draggable so a dispatcher can
 * drag an unscheduled job straight onto a calendar window band. Rendered INSIDE
 * the calendar's DndContext (see InteractiveSchedulingCalendar). The S2
 * UnscheduledPanel remains for the read-only surfaces.
 */
export function DraggableUnscheduledPanel({
  jobs,
  isLoading,
  onSelect,
  disabled,
}: DraggableUnscheduledPanelProps) {
  // Drop target: releasing a placed job card here clears its placement and
  // returns it to the queue (handled in InteractiveSchedulingCalendar).
  const dropData: UnscheduledDropZoneData = { kind: 'unscheduled' };
  const { setNodeRef, isOver } = useDroppable({
    id: UNSCHEDULED_DROP_ID,
    data: dropData,
  });

  return (
    <Card
      ref={setNodeRef}
      // Drop affordance per the motion spec: dashed marker outline + a
      // primary-soft fill, applied with no transition so it lands instantly.
      className={`flex w-full flex-col p-3 lg:w-72 lg:shrink-0 ${
        isOver ? 'border-dashed border-marker bg-primary-soft' : ''
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Inbox className="size-4 text-warning-strong" />
        <h2 className="text-[13px] font-semibold">Unscheduled</h2>
        {!isLoading && (
          <span
            className="ml-auto font-mono text-xs tabular-nums text-muted-foreground"
            title={
              jobs.length >= DASHBOARD_LIST_LIMIT
                ? `Showing the first ${DASHBOARD_LIST_LIMIT}`
                : undefined
            }
          >
            {jobs.length}
            {jobs.length >= DASHBOARD_LIST_LIMIT ? '+' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={`unsched-skeleton-${i}`} className="h-16 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nothing to place.
        </p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <UnscheduledRow
                job={job}
                onSelect={onSelect}
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
