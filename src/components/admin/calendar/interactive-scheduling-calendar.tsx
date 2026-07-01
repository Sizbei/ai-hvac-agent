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
  businessMinutesOfDay,
  toBusinessWallClock,
} from '@/lib/admin/calendar-time';
import {
  applyOptimisticReschedule,
  applyOptimisticUnschedule,
  currentScopeOf,
  UNASSIGNED_SCOPE,
} from '@/lib/admin/calendar-optimistic';
import { isWindowWithinAvailability } from '@/lib/admin/availability-coverage';
import type { DragJobData, CalendarDropData } from '@/lib/admin/calendar-dnd';
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
  /** Jump to a specific business day in Day view (week day-header click). */
  readonly onPickDay?: (isoDay: string) => void;
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

/**
 * Wide week view: a full-width time grid (Google/HCP style). A single left hour
 * axis, then 7 EQUAL-width day columns (flex-1, no horizontal scroll) Sun→Sat.
 * Each column is a continuous day lane showing every job that day; the current
 * day is highlighted and a "now" line is drawn when today is in range. Clicking a
 * day header jumps into Day view for that date.
 *
 * Drag-to-reschedule is preserved: each column's bands are registered under the
 * unassigned scope, so a drop moves the job's DAY/window only — technician
 * assignment is unchanged server-side (rescheduleRequest never touches
 * assignedTo), matching the prior week behavior.
 */
function WeekView({
  days,
  allJobs,
  onSelect,
  onPickDay,
  disabled,
}: {
  readonly days: readonly string[];
  readonly allJobs: readonly DashboardRequest[];
  readonly onSelect: (id: string) => void;
  readonly onPickDay?: (isoDay: string) => void;
  readonly disabled?: boolean;
}) {
  const todayIso = businessIsoDate(new Date());
  return (
    <div className="flex gap-2">
      {/* pt-7 (28px) offsets the hour axis down past the clickable day-header
          row so the axis lines up with hour 0 of the lanes. Matches the header
          height: py-1 (8) + text-xs line-height (16) + mb-1 (4) = 28px. */}
      <div className="pt-7">
        <TimeAxis />
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-7 gap-1.5">
        {days.map((isoDay) => {
          const noonUtc = new Date(`${isoDay}T12:00:00.000Z`);
          const wall = toBusinessWallClock(noonUtc);
          const weekday = new Date(
            Date.UTC(wall.year, wall.month - 1, wall.day),
          ).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
          const isToday = isoDay === todayIso;
          return (
            <div key={isoDay} className="flex min-w-0 flex-col">
              <button
                type="button"
                onClick={() => onPickDay?.(isoDay)}
                title="Open this day"
                aria-label={`Open ${isoDay} in day view`}
                className={`mb-1 rounded-md py-1 text-center text-xs font-semibold transition-colors hover:bg-muted ${
                  isToday
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground'
                }`}
              >
                {weekday}{' '}
                <span
                  className={
                    isToday ? 'font-bold' : 'font-normal text-muted-foreground'
                  }
                >
                  {wall.month}/{wall.day}
                </span>
              </button>
              <div className="relative">
                {isToday && <NowLine />}
                <DayLane
                  scope={UNASSIGNED_SCOPE}
                  jobs={allJobs}
                  isoDay={isoDay}
                  onSelect={onSelect}
                  compact
                  disabled={disabled}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A thin horizontal "current time" indicator, positioned within the day grid by
 * the business-tz minute-of-day. Hidden when the current time is outside the
 * rendered window (before CALENDAR_START_HOUR or after CALENDAR_END_HOUR). */
function NowLine() {
  const minutes = businessMinutesOfDay(new Date());
  const startMin = CALENDAR_START_HOUR * 60;
  const endMin = CALENDAR_END_HOUR * 60;
  if (minutes < startMin || minutes > endMin) return null;
  const topPx = ((minutes - startMin) / (endMin - startMin)) * GRID_PX;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ top: topPx }}
      aria-hidden
    >
      <div className="relative h-px bg-red-500">
        <div className="absolute -left-1 -top-1 size-2 rounded-full bg-red-500" />
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
  onPickDay,
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
  const { reschedule, unschedule, isRescheduling } = useRescheduleJob();
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
    const dropData = event.over?.data.current as CalendarDropData | undefined;
    if (!board || dragData?.kind !== 'job') return;

    // Drag-back-to-Unscheduled: clear the placement and return the card to the queue.
    if (dropData?.kind === 'unscheduled') {
      const prev = board;
      const next = applyOptimisticUnschedule(prev, dragData.requestId);
      if (next === prev) return;
      setBoard(next);
      const result = await unschedule(dragData.requestId);
      if (result.status === 'error') {
        setBoard(prev);
        onStatus(result.message, 'error');
      }
      onRefetch();
      return;
    }

    if (dropData?.kind !== 'window') return;

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
                  onPickDay={onPickDay}
                  disabled={isRescheduling}
                />
              ) : (
                <DayView
                  lanes={board.lanes}
                  unassigned={board.unassigned}
                  // board.days is always non-empty in practice (the route sends
                  // [date] for a day view), but days[0] is typed string|undefined
                  // under noUncheckedIndexedAccess; fall back to today's Eastern
                  // date so a (transient) empty board never passes undefined into
                  // a required string prop.
                  isoDay={board.days[0] ?? businessIsoDate(new Date())}
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
