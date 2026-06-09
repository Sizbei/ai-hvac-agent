'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  dropZoneId,
  type DropZoneData,
} from '@/lib/admin/calendar-dnd';
import type { RescheduleWindowRow } from '@/lib/admin/calendar-time';

interface DroppableWindowBandProps {
  /** Lane scope: a technicianId, or the literal "unassigned". */
  readonly scope: string;
  readonly isoDay: string;
  readonly window: RescheduleWindowRow;
  /** Absolute position within the lane grid, in px (from windowBandPlacement). */
  readonly topPx: number;
  readonly heightPx: number;
  /** True when this window falls OUTSIDE the technician's working hours for the
   * day — shaded dim so the dispatcher sees a drop here is out-of-hours (S4).
   * Never set for the unassigned lane (no tech, no hours). */
  readonly outOfHours?: boolean;
}

/**
 * An invisible drop target covering one window band (e.g. morning 8–12 Eastern)
 * of a single lane/day. Sits BEHIND the absolutely-positioned job cards (lower
 * z-index, pointer-events only matter to @dnd-kit's collision detection, which
 * works off the registered rects, not the DOM stacking). Highlights while a card
 * is dragged over it so the dispatcher sees the target slot.
 */
export function DroppableWindowBand({
  scope,
  isoDay,
  window,
  topPx,
  heightPx,
  outOfHours,
}: DroppableWindowBandProps) {
  const data: DropZoneData = { kind: 'window', scope, isoDay, window };
  const { setNodeRef, isOver } = useDroppable({
    id: dropZoneId(scope, isoDay, window),
    data,
  });

  // Out-of-hours bands get a dim hatch so a drop there reads as off-shift; the
  // drag-over highlight (amber, not sky) reinforces that this slot would warn.
  const baseClass = outOfHours
    ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(120,113,108,0.12)_6px,rgba(120,113,108,0.12)_12px)]'
    : '';
  const overClass = isOver
    ? outOfHours
      ? 'border-dashed border-amber-400 bg-amber-100/50 dark:bg-amber-900/30'
      : 'border-dashed border-sky-400 bg-sky-100/60 dark:bg-sky-900/40'
    : '';

  return (
    <div
      ref={setNodeRef}
      className={`absolute inset-x-0 rounded-sm border border-transparent transition-colors ${baseClass} ${overClass}`}
      style={{ top: topPx, height: heightPx }}
      data-window={window}
      data-out-of-hours={outOfHours ? 'true' : undefined}
      aria-hidden
    />
  );
}
