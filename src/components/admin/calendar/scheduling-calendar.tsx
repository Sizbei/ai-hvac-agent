'use client';

import { useMemo } from 'react';
import { User, Inbox } from 'lucide-react';
import { CalendarJobCard } from '@/components/admin/calendar/calendar-job-card';
import {
  CALENDAR_START_HOUR,
  CALENDAR_END_HOUR,
  hourRowLabels,
  placeJobInGrid,
  businessIsoDate,
  toBusinessWallClock,
} from '@/lib/admin/calendar-time';
import type {
  SchedulingCalendar,
  CalendarTechnicianLane,
  DashboardRequest,
} from '@/lib/admin/types';
import type { CalendarView } from '@/hooks/use-scheduling-calendar';

interface SchedulingCalendarProps {
  readonly calendar: SchedulingCalendar | null;
  readonly view: CalendarView;
  readonly onSelect: (id: string) => void;
}

/** Pixel height of one hour row; the whole grid is (hours * this) tall so the
 * fractional placements from placeJobInGrid map to absolute offsets. */
const HOUR_PX = 56;
const GRID_HOURS = CALENDAR_END_HOUR - CALENDAR_START_HOUR;
const GRID_PX = GRID_HOURS * HOUR_PX;

/** A job placed in a single day's grid, with its vertical offset/height in px. */
interface PositionedJob {
  readonly job: DashboardRequest;
  readonly topPx: number;
  readonly heightPx: number;
}

/** Position every job that has a window into the grid for the given iso day,
 * dropping any whose window falls outside the visible hours. */
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
    // Only place jobs that actually fall on this business day.
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

/** The hour-grid backdrop (shared by every column): horizontal lines per hour. */
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

/** The left time axis: one label per hour, business-timezone clock. */
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

/** A single vertical lane (one technician, or the unassigned pile) for one day. */
function DayLane({
  jobs,
  isoDay,
  onSelect,
  compact,
}: {
  readonly jobs: readonly DashboardRequest[];
  readonly isoDay: string;
  readonly onSelect: (id: string) => void;
  readonly compact?: boolean;
}) {
  const positioned = useMemo(
    () => positionJobs(jobs, isoDay),
    [jobs, isoDay],
  );

  return (
    <div
      className="relative flex-1 rounded-md bg-muted/20"
      style={{ height: GRID_PX }}
      // S3 will attach a useDroppable ref here keyed by (technician, day).
      data-calendar-lane={isoDay}
    >
      <HourLines />
      {positioned.map(({ job, topPx, heightPx }) => (
        <div
          key={job.id}
          className="absolute inset-x-0.5"
          style={{ top: topPx, height: heightPx }}
        >
          <CalendarJobCard job={job} onSelect={onSelect} compact={compact} />
        </div>
      ))}
    </div>
  );
}

/** Day view: a column per active technician + an unassigned lane, sharing one
 * time axis. Each lane stacks that tech's jobs at their arrival-window row. */
function DayView({
  lanes,
  unassigned,
  isoDay,
  onSelect,
}: {
  readonly lanes: readonly CalendarTechnicianLane[];
  readonly unassigned: readonly DashboardRequest[];
  readonly isoDay: string;
  readonly onSelect: (id: string) => void;
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
          <DayLane jobs={unassigned} isoDay={isoDay} onSelect={onSelect} />
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
            <DayLane jobs={lane.jobs} isoDay={isoDay} onSelect={onSelect} />
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

/** Week view: a column per business day; each day stacks every job (across all
 * technicians + unassigned) at its arrival-window row. Compact cards. */
function WeekView({
  days,
  allJobs,
  onSelect,
}: {
  readonly days: readonly string[];
  readonly allJobs: readonly DashboardRequest[];
  readonly onSelect: (id: string) => void;
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
              <DayLane jobs={allJobs} isoDay={isoDay} onSelect={onSelect} compact />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The read-only scheduling calendar (Stage 2). Renders technicians as columns
 * and the business-hours time axis (7am–8pm Eastern) as rows for a day, or a
 * column per day for a week. ALL times render in America/New_York via the
 * calendar-time helpers (Intl timeZone), never the viewer's browser zone, and
 * placement is DST-correct because it derives from real instants.
 *
 * The lane/card structure is @dnd-kit-ready: lanes expose a data attribute for a
 * future useDroppable and cards are self-contained for useDraggable — S3 adds
 * interactions without restructuring this view.
 */
export function SchedulingCalendarView({
  calendar,
  view,
  onSelect,
}: SchedulingCalendarProps) {
  // Flatten every placed job (all techs + unassigned) for the week grid.
  const allJobs = useMemo<readonly DashboardRequest[]>(() => {
    if (!calendar) return [];
    return [
      ...calendar.lanes.flatMap((lane) => lane.jobs),
      ...calendar.unassigned,
    ];
  }, [calendar]);

  if (!calendar) return null;

  return (
    <div className="rounded-lg border bg-card p-3">
      {view === 'week' ? (
        <WeekView days={calendar.days} allJobs={allJobs} onSelect={onSelect} />
      ) : (
        <DayView
          lanes={calendar.lanes}
          unassigned={calendar.unassigned}
          isoDay={calendar.days[0]}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
