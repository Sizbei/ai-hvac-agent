'use client';

import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import { User, Inbox } from 'lucide-react';
import { CalendarJobCard } from '@/components/admin/calendar/calendar-job-card';
import { DraggableJobCard } from '@/components/admin/calendar/draggable-job-card';
import { DroppableWindowBand } from '@/components/admin/calendar/droppable-window-band';
import { DraggableUnscheduledPanel } from '@/components/admin/calendar/draggable-unscheduled-panel';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CALENDAR_START_HOUR,
  CALENDAR_END_HOUR,
  RESCHEDULE_WINDOW_ROWS,
  hourRowLabels,
  placeJobInGrid,
  windowBandPlacement,
  businessIsoDate,
  toBusinessWallClock,
} from '@/lib/admin/calendar-time';
import {
  applyOptimisticReschedule,
  currentScopeOf,
  UNASSIGNED_SCOPE,
} from '@/lib/admin/calendar-optimistic';
import { isWindowWithinAvailability } from '@/lib/admin/availability-coverage';
import type { DragJobData, DropZoneData } from '@/lib/admin/calendar-dnd';
import {
  useRescheduleJob,
  type RescheduleConflictDetail,
} from '@/hooks/use-reschedule-job';
import { ConflictDialog } from '@/components/admin/calendar/conflict-dialog';
import type {
  SchedulingCalendar,
  CalendarTechnicianLane,
  DashboardRequest,
  AvailabilitySlot,
} from '@/lib/admin/types';
import type { CalendarView } from '@/hooks/use-scheduling-calendar';
import type { ArrivalWindow } from '@/lib/admin/arrival-window';

interface InteractiveSchedulingCalendarProps {
  readonly calendar: SchedulingCalendar | null;
  readonly view: CalendarView;
  readonly onSelect: (id: string) => void;
  /** Re-pull the authoritative board after a confirmed (or rolled-back) move. */
  readonly onRefetch: () => void;
  /** Surface a transient status (conflict warning / failure) to the page. */
  readonly onStatus: (message: string, tone: 'warning' | 'error') => void;
  /** Whether the initial board is still loading (drives the skeletons). */
  readonly isLoading: boolean;
}

/** Same grid geometry as the read-only S2 view. */
const HOUR_PX = 56;
const GRID_HOURS = CALENDAR_END_HOUR - CALENDAR_START_HOUR;
const GRID_PX = GRID_HOURS * HOUR_PX;

interface PositionedJob {
  readonly job: DashboardRequest;
  readonly topPx: number;
  readonly heightPx: number;
}

function positionJobs(
  jobs: readonly DashboardRequest[],
  isoDay: string,
): readonly PositionedJob[] {
  const positioned: PositionedJob[] = [];
  for (const job of jobs) {
    if (!job.arrivalWindowStart || !job.arrivalWindowEnd) continue;
    const start = new Date(job.arrivalWindowStart);
    const end = new Date(job.arrivalWindowEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (businessIsoDate(start) !== isoDay) continue;
    const placement = placeJobInGrid(start, end);
    if (!placement) continue;
    positioned.push({
      job,
      topPx: placement.top * GRID_PX,
      heightPx: Math.max(placement.height * GRID_PX, 28),
    });
  }
  return positioned;
}

function HourLines() {
  return (
    <div className="pointer-events-none absolute inset-0">
      {Array.from({ length: GRID_HOURS }, (_, i) => (
        <div
          key={`line-${i}`}
          className="border-b border-dashed border-border/60"
          style={{ height: HOUR_PX }}
        />
      ))}
    </div>
  );
}

function TimeAxis() {
  const labels = hourRowLabels();
  return (
    <div className="w-14 shrink-0 pr-2 text-right">
      {labels.map((label, i) => (
        <div
          key={label}
          className="relative text-[10px] tabular-nums text-muted-foreground"
          style={{ height: HOUR_PX }}
        >
          <span className="absolute -top-1.5 right-0">{i === 0 ? '' : label}</span>
        </div>
      ))}
    </div>
  );
}

/** One droppable lane (a technician or the unassigned pile) for a single day.
 * Lays the three window bands behind the placed (draggable) cards. When the lane
 * is a technician with availability, out-of-hours bands are shaded (S4). */
function DayLane({
  scope,
  jobs,
  isoDay,
  onSelect,
  compact,
  disabled,
  availability,
}: {
  readonly scope: string;
  readonly jobs: readonly DashboardRequest[];
  readonly isoDay: string;
  readonly onSelect: (id: string) => void;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  /** This technician's recurring slots (empty for the unassigned lane, which has
   * no hours to shade against). */
  readonly availability?: readonly AvailabilitySlot[];
}) {
  const positioned = useMemo(() => positionJobs(jobs, isoDay), [jobs, isoDay]);

  return (
    <div
      className="relative flex-1 rounded-md bg-muted/20"
      style={{ height: GRID_PX }}
    >
      <HourLines />
      {RESCHEDULE_WINDOW_ROWS.map((window) => {
        const band = windowBandPlacement(window);
        if (!band) return null;
        // Shade only a TECH lane's bands: the unassigned lane has no hours.
        const outOfHours =
          scope !== UNASSIGNED_SCOPE &&
          availability !== undefined &&
          !isWindowWithinAvailability(
            availability,
            isoDay,
            window as ArrivalWindow,
          );
        return (
          <DroppableWindowBand
            key={`${scope}-${isoDay}-${window}`}
            scope={scope}
            isoDay={isoDay}
            window={window}
            topPx={band.top * GRID_PX}
            heightPx={band.height * GRID_PX}
            outOfHours={outOfHours}
          />
        );
      })}
      {positioned.map(({ job, topPx, heightPx }) => (
        <div
          key={job.id}
          className="absolute inset-x-0.5 z-10"
          style={{ top: topPx, height: heightPx }}
        >
          <DraggableJobCard
            job={job}
            onSelect={onSelect}
            compact={compact}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

function DayView({
  lanes,
  unassigned,
  isoDay,
  onSelect,
  disabled,
  availabilityByTech,
}: {
  readonly lanes: readonly CalendarTechnicianLane[];
  readonly unassigned: readonly DashboardRequest[];
  readonly isoDay: string;
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
  /** technicianId → that tech's recurring slots, for out-of-hours shading. */
  readonly availabilityByTech: ReadonlyMap<string, readonly AvailabilitySlot[]>;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      <TimeAxis />
      <div className="flex min-w-0 flex-1 gap-2">
        <div className="flex w-56 shrink-0 flex-col">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <Inbox className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="truncate">Unassigned</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {unassigned.length}
            </span>
          </div>
          <DayLane
            scope={UNASSIGNED_SCOPE}
            jobs={unassigned}
            isoDay={isoDay}
            onSelect={onSelect}
            disabled={disabled}
          />
        </div>
        {lanes.map((lane) => (
          <div key={lane.technicianId} className="flex w-56 shrink-0 flex-col">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <User className="size-4 text-muted-foreground" />
              <span className="truncate">{lane.technicianName}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {lane.jobs.length}
              </span>
            </div>
            <DayLane
              scope={lane.technicianId}
              jobs={lane.jobs}
              isoDay={isoDay}
              onSelect={onSelect}
              disabled={disabled}
              availability={availabilityByTech.get(lane.technicianId) ?? []}
            />
          </div>
        ))}
        {lanes.length === 0 && (
          <p className="self-center text-sm text-muted-foreground">
            No active technicians. Add technicians under Staff.
          </p>
        )}
      </div>
    </div>
  );
}

/** Week view: one column per business day. Dropping in week view keeps the job
 * in its current lane (scope) — the column only changes the DAY/window. We use the
 * unassigned scope per day for placed-but-unassigned and per-tech for the rest by
 * routing the drop to the job's existing scope (resolved in the drop handler). */
function WeekView({
  days,
  allJobs,
  onSelect,
  disabled,
}: {
  readonly days: readonly string[];
  readonly allJobs: readonly DashboardRequest[];
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
}) {
  const todayIso = businessIsoDate(new Date());
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      <TimeAxis />
      <div className="flex min-w-0 flex-1 gap-2">
        {days.map((isoDay) => {
          const noonUtc = new Date(`${isoDay}T12:00:00.000Z`);
          const wall = toBusinessWallClock(noonUtc);
          const weekday = new Date(
            Date.UTC(wall.year, wall.month - 1, wall.day),
          ).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
          const isToday = isoDay === todayIso;
          return (
            <div key={isoDay} className="flex min-w-32 flex-1 flex-col">
              <div
                className={`mb-1 text-center text-xs font-semibold ${
                  isToday ? 'text-primary' : 'text-foreground'
                }`}
              >
                {weekday}{' '}
                <span className="font-normal text-muted-foreground">
                  {wall.month}/{wall.day}
                </span>
              </div>
              {/* Week-view drops scope to the day's unassigned lane band: the
                  reschedule moves day+window; technician assignment is unchanged
                  server-side (rescheduleRequest never touches assignedTo). */}
              <DayLane
                scope={UNASSIGNED_SCOPE}
                jobs={allJobs}
                isoDay={isoDay}
                onSelect={onSelect}
                compact
                disabled={disabled}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The INTERACTIVE scheduling calendar (Stage 3): the read-only S2 grid plus
 * drag-to-reschedule. Cards are @dnd-kit draggables, window bands are droppables;
 * dropping a card optimistically moves it (applyOptimisticReschedule) and POSTs to
 * the reschedule endpoint, rolling back + refetching on failure. All time math
 * stays in calendar-time.ts (Eastern render, UTC persist). Client-only; the page
 * fetches the board and passes it in, so there's no SSR hydration risk.
 */
export function InteractiveSchedulingCalendar({
  calendar,
  view,
  onSelect,
  onRefetch,
  onStatus,
  isLoading,
}: InteractiveSchedulingCalendarProps) {
  // Optimistic copy of the board. Local drops mutate this copy; it is RESET to
  // the authoritative payload whenever a new `calendar` prop arrives (poll /
  // refetch / date change). We adjust state during render by tracking the last
  // prop reference — React's recommended alternative to a setState-in-effect
  // sync (no cascading render, no effect): see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [board, setBoard] = useState<SchedulingCalendar | null>(calendar);
  const [lastCalendar, setLastCalendar] = useState<SchedulingCalendar | null>(
    calendar,
  );
  if (calendar !== lastCalendar) {
    setLastCalendar(calendar);
    setBoard(calendar);
  }
  const [activeJob, setActiveJob] = useState<DashboardRequest | null>(null);
  const { reschedule, isRescheduling } = useRescheduleJob();
  // Hold the pre-move board so a failed POST can roll back exactly.
  const rollbackRef = useRef<SchedulingCalendar | null>(null);

  // A HARD conflict the server blocked (409): we've rolled the board back and
  // ask the dispatcher to cancel or override. `pending` is the move to retry
  // verbatim with override:true.
  const [conflict, setConflict] = useState<{
    readonly detail: RescheduleConflictDetail;
    readonly message: string;
    readonly pending: {
      readonly requestId: string;
      readonly date: string;
      readonly arrivalWindow: ArrivalWindow;
      readonly technicianId?: string;
      readonly scope: string;
      readonly optimisticBoard: SchedulingCalendar;
    };
  } | null>(null);

  // technicianId → slots, so day-view lanes can shade out-of-hours bands.
  const availabilityByTech = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    for (const slot of board?.availability ?? []) {
      const list = map.get(slot.technicianId) ?? [];
      list.push(slot);
      map.set(slot.technicianId, list);
    }
    return map as ReadonlyMap<string, readonly AvailabilitySlot[]>;
  }, [board]);

  // PointerSensor needs a small drag distance and TouchSensor a short press so a
  // TAP (open detail) isn't hijacked into a drag. Matches the S2 comment.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
  );

  const allJobs = useMemo<readonly DashboardRequest[]>(() => {
    if (!board) return [];
    return [...board.lanes.flatMap((lane) => lane.jobs), ...board.unassigned];
  }, [board]);

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragJobData | undefined;
    if (data?.kind !== 'job' || !board) return;
    const all = [
      ...board.lanes.flatMap((l) => l.jobs),
      ...board.unassigned,
      ...board.unscheduled,
    ];
    setActiveJob(all.find((j) => j.id === data.requestId) ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveJob(null);
    const dragData = event.active.data.current as DragJobData | undefined;
    const dropData = event.over?.data.current as DropZoneData | undefined;
    if (!board || dragData?.kind !== 'job' || dropData?.kind !== 'window') {
      return;
    }

    const prev = board;
    const currentScope =
      currentScopeOf(prev, dragData.requestId) ?? UNASSIGNED_SCOPE;
    // S4 drag-to-ASSIGN: in DAY view, the drop zone's scope is the target lane.
    // If it's a real technician lane that differs from the job's current lane,
    // the drop reassigns (and re-times) the job. Week-view bands are all
    // registered under the unassigned scope, so they never reassign (reschedule
    // only). Dropping onto the unassigned lane keeps the current assignee — we
    // never auto-unassign on a drop.
    const dropScope = dropData.scope;
    const isReassign =
      dropScope !== UNASSIGNED_SCOPE && dropScope !== currentScope;
    const technicianId = isReassign ? dropScope : undefined;
    // The lane the card should optimistically land in: the new tech on a
    // reassign, else its current lane (WHEN-only move).
    const optimisticScope = isReassign ? dropScope : currentScope;

    const next = applyOptimisticReschedule(prev, {
      requestId: dragData.requestId,
      scope: optimisticScope,
      isoDay: dropData.isoDay,
      window: dropData.window,
    });
    // Nothing matched (shouldn't happen) → skip the network round-trip.
    if (next === prev) return;

    rollbackRef.current = prev;
    setBoard(next);

    const result = await reschedule({
      requestId: dragData.requestId,
      date: dropData.isoDay,
      arrivalWindow: dropData.window,
      technicianId,
    });

    if (result.status === 'conflict') {
      // HARD block: roll the board back and open the warning dialog so the
      // dispatcher can cancel or override. We DON'T refetch yet — overriding
      // re-applies the same optimistic move.
      setBoard(prev);
      setConflict({
        detail: result.detail,
        message: result.message,
        pending: {
          requestId: dragData.requestId,
          date: dropData.isoDay,
          arrivalWindow: dropData.window as ArrivalWindow,
          technicianId,
          scope: optimisticScope,
          optimisticBoard: next,
        },
      });
      return;
    }

    if (result.status === 'error') {
      setBoard(prev);
      onStatus(result.message, 'error');
      onRefetch();
      return;
    }

    // Re-pull authoritative data so server-side ordering/derived fields settle.
    onRefetch();
  }

  /** Re-POST the blocked move with override:true after the dispatcher confirms. */
  async function handleOverride() {
    if (!conflict) return;
    const { pending } = conflict;
    // Re-apply the optimistic move (board was rolled back when we opened the dialog).
    rollbackRef.current = board;
    setBoard(pending.optimisticBoard);

    const result = await reschedule({
      requestId: pending.requestId,
      date: pending.date,
      arrivalWindow: pending.arrivalWindow,
      technicianId: pending.technicianId,
      override: true,
    });

    setConflict(null);
    if (result.status !== 'ok') {
      setBoard(rollbackRef.current);
      onStatus(
        result.status === 'error'
          ? result.message
          : 'Could not schedule the job.',
        'error',
      );
      onRefetch();
      return;
    }
    onStatus('Scheduled despite the conflict.', 'warning');
    onRefetch();
  }

  const showSkeleton = isLoading && !board;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToWindowEdges]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          {showSkeleton || !board ? (
            <Skeleton className="h-[28rem] w-full" />
          ) : (
            <div className="rounded-lg border bg-card p-3">
              {view === 'week' ? (
                <WeekView
                  days={board.days}
                  allJobs={allJobs}
                  onSelect={onSelect}
                  disabled={isRescheduling}
                />
              ) : (
                <DayView
                  lanes={board.lanes}
                  unassigned={board.unassigned}
                  isoDay={board.days[0]}
                  onSelect={onSelect}
                  disabled={isRescheduling}
                  availabilityByTech={availabilityByTech}
                />
              )}
            </div>
          )}
        </div>

        <DraggableUnscheduledPanel
          jobs={board?.unscheduled ?? []}
          isLoading={showSkeleton}
          onSelect={onSelect}
          disabled={isRescheduling}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeJob ? (
          <div className="w-52 opacity-90 shadow-lg">
            <CalendarJobCard job={activeJob} onSelect={() => {}} />
          </div>
        ) : null}
      </DragOverlay>

      <ConflictDialog
        conflict={conflict?.detail ?? null}
        message={conflict?.message ?? ''}
        isSubmitting={isRescheduling}
        onOverride={handleOverride}
        onCancel={() => {
          setConflict(null);
          onRefetch();
        }}
      />
    </DndContext>
  );
}
