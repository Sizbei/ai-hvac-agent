'use client';

import { useDraggable } from '@dnd-kit/core';
import { CalendarJobCard } from '@/components/admin/calendar/calendar-job-card';
import type { DashboardRequest } from '@/lib/admin/types';
import { dragJobId, type DragJobData } from '@/lib/admin/calendar-dnd';

interface DraggableJobCardProps {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  readonly compact?: boolean;
  /** Disabled while a reschedule is in flight, so a second drag can't race it. */
  readonly disabled?: boolean;
}

/**
 * A CalendarJobCard wrapped in @dnd-kit useDraggable. The drag payload (DragJobData)
 * carries the job id + its current window start so the drop handler can reschedule
 * and detect a no-op move. We do NOT swallow the card's click (open-detail): the
 * PointerSensor/TouchSensor activation constraint on the DndContext requires a
 * small move/hold before a drag begins, so a plain tap still opens the sheet.
 *
 * While dragging we dim the source (the DragOverlay renders the moving clone), so
 * the grid shows where the card came from without a duplicate following the pointer.
 */
export function DraggableJobCard({
  job,
  onSelect,
  compact,
  disabled,
}: DraggableJobCardProps) {
  const data: DragJobData = {
    kind: 'job',
    requestId: job.id,
    currentStartIso: job.arrivalWindowStart,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragJobId(job.id),
    data,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      // The inner CalendarJobCard renders a <button>, so we clear the
      // role="button" that dnd-kit spreads via attributes to avoid a nested
      // interactive-role violation. The drag listeners stay on this wrapper.
      role={undefined}
      className={`h-full w-full touch-none ${isDragging ? 'opacity-40' : ''} ${
        disabled ? 'cursor-progress' : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <CalendarJobCard job={job} onSelect={onSelect} compact={compact} />
    </div>
  );
}
