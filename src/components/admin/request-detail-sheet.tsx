'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { TagChipPicker } from '@/components/admin/tag-chip-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { ScopedEstimatesSection } from '@/components/admin/estimates/scoped-estimates-section';
import { ScopedInvoicesSection } from '@/components/admin/invoices/scoped-invoices-section';
import { AttachmentsSection } from '@/components/admin/attachments-section';
import { RequestFormsSection } from '@/components/admin/request-forms-section';
import {
  allowedTransitions,
  MANUAL_TARGET_STATUSES,
  HOLD_REASONS,
  type RequestStatus,
  type HoldReason,
} from '@/lib/admin/request-status';
import {
  ARRIVAL_WINDOWS,
  formatArrivalWindow,
  type ArrivalWindow,
} from '@/lib/admin/arrival-window';
import type {
  AdminRequest,
  AdminRequestDetail,
  TechnicianRecord,
  RequestNote,
} from '@/lib/admin/types';
import { CalendarClock, ChevronDown, ChevronRight } from 'lucide-react';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { WindowPicker, useAvailability, type WindowPickerValue } from '@/components/admin/window-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MAX_TECHNICIANS_PER_VISIT, type AppointmentRecord } from '@/lib/admin/appointment-types';
import { WINDOW_LABELS, formatIsoDayShort, initialVisitDay } from '@/lib/admin/create-request';
import {
  BUSINESS_TIME_ZONE,
  arrivalWindowUtcForBusinessDate,
  businessIsoDate,
  formatBusinessTime,
  windowRowOfInstant,
} from '@/lib/admin/calendar-time';
import { cn } from '@/lib/utils';
import { humanizeSeconds } from '@/lib/admin/duration-format';
import { formatCentsExact } from '@/lib/admin/money-format';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { SyncPill } from '@/components/admin/sync-pill';
import { issueTypeLabel } from '@/lib/admin/request-labels';
import { canSaveSchedule, scheduleInputsFrom } from '@/lib/admin/request-schedule-inputs';
import { cancelRequestDescription, sheetVisitView } from '@/lib/admin/request-visit-view';

// Only manual targets can ever be a transition button — narrowing the map to
// those keys makes any drift from the state machine a compile error rather than
// dead code.
type ManualTargetStatus = (typeof MANUAL_TARGET_STATUSES)[number];

const STATUS_ACTION_LABELS: Record<ManualTargetStatus, string> = {
  scheduled: 'Mark scheduled',
  en_route: 'Mark en route',
  arrived: 'Mark arrived',
  in_progress: 'Start work',
  on_hold: 'Put on hold',
  completed: 'Mark complete',
  cancelled: 'Cancel request',
};

// Spoken-friendly labels for the arrival-window selector.
const ARRIVAL_WINDOW_LABELS: Record<ArrivalWindow, string> = {
  morning: 'Morning (8am–12pm)',
  afternoon: 'Afternoon (12–4pm)',
  evening: 'Evening (4–8pm)',
  anytime: 'Anytime (8am–8pm)',
};

const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  awaiting_parts: 'Awaiting parts',
  awaiting_customer: 'Awaiting customer',
  awaiting_access: 'Awaiting access',
  weather: 'Weather',
  other: 'Other',
};

// Per-field display maps for the intake enums. Keeping them explicit (rather
// than auto-title-casing) lets us spell out the cases that don't title-case
// cleanly — "Central AC", "10–15 years", "ASAP", etc.
const JOB_TYPE_LABELS: Record<string, string> = {
  no_heat: 'No heat',
  no_cool: 'No cooling',
  service_call: 'Service call',
  maintenance: 'Maintenance',
  install: 'Installation',
  estimate: 'Estimate',
  warranty: 'Warranty',
  diagnostic: 'Diagnostic',
  inspection: 'Inspection',
};

const SYSTEM_TYPE_LABELS: Record<string, string> = {
  central_ac: 'Central AC',
  furnace: 'Furnace',
  heat_pump: 'Heat pump',
  mini_split: 'Mini-split',
  boiler: 'Boiler',
  packaged_unit: 'Packaged unit',
  other: 'Other',
};

const EQUIPMENT_AGE_LABELS: Record<string, string> = {
  under_5: 'Under 5 years',
  '5_to_10': '5–10 years',
  '10_to_15': '10–15 years',
  over_15: 'Over 15 years',
  unknown: 'Unknown',
};

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
};

const OWNER_OCCUPANT_LABELS: Record<string, string> = {
  owner: 'Owner',
  renter: 'Renter',
  unknown: 'Unknown',
};

const WARRANTY_LABELS: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  unknown: 'Unknown',
};

const SYSTEM_STATUS_LABELS: Record<string, string> = {
  fully_down: 'Completely down',
  partially_working: 'Partially working',
  unknown: 'Unknown',
};

const PREFERRED_WINDOW_LABELS: Record<string, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  asap: 'ASAP',
};

const CONTACT_PREFERENCE_LABELS: Record<string, string> = {
  call: 'Call',
  text: 'Text',
};

const LEAD_SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  facebook: 'Facebook',
  yelp: 'Yelp',
  referral: 'Referral',
  repeat_customer: 'Repeat customer',
  website: 'Website',
  direct_mail: 'Direct mail',
  other: 'Other',
};

// Map a raw enum value through a label map, falling back to a humanized form of
// the raw value (snake_case → "Snake case") so unknown/new enum members still
// render legibly rather than as raw tokens.
function humanizeIntakeValue(
  value: string | null,
  labels: Record<string, string>,
): string | null {
  if (value === null) return null;
  const mapped = labels[value];
  if (mapped) return mapped;
  const words = value.split('_');
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Booleans render as Yes/No; null passes through to InfoRow's "Not provided".
function boolLabel(value: boolean | null): string | null {
  if (value === null) return null;
  return value ? 'Yes' : 'No';
}

interface RequestDetailSheetProps {
  readonly requestId: string | null;
  readonly onClose: () => void;
  readonly onAssigned: () => void;
}

// One advisory, scored technician suggestion (mirrors RankedTech from the
// dispatch scorer; the API returns these top-3 with human-readable reasons).
interface DispatchSuggestion {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
}

interface DispatchDecisionCandidateView {
  readonly technicianId: string;
  readonly name: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
  // null = unknown (legacy row without the stored flag) → render no indicator.
  readonly skillMatched: boolean | null;
}
interface DispatchDecisionView {
  readonly outcome: string;
  readonly isShadow: boolean;
  readonly chosenTechnicianId: string | null;
  readonly topScore: number | null;
  readonly confidenceGap: number | null;
  readonly createdAt: string;
  readonly overriddenTechnicianId: string | null;
  readonly overriddenByUserId: string | null;
  readonly overriddenAt: string | null;
  readonly candidates: readonly DispatchDecisionCandidateView[];
}

// Invoice/payment status synced from Housecall Pro invoice.* webhooks. Hidden
// when there's no invoice activity yet ('none' / falsy). Color cues: paid green,
// sent blue, void muted.
function InvoiceStatusBadge({ status }: { readonly status: string }) {
  if (!status || status === 'none') {
    return null;
  }
  const styles: Record<string, string> = {
    sent: 'border-info-border bg-info-light text-info-strong',
    paid: 'border-success-border bg-success-light text-success-strong',
    void: 'border-border bg-muted text-muted-foreground',
  };
  const labels: Record<string, string> = {
    sent: 'Invoice sent',
    paid: 'Invoice paid',
    void: 'Invoice voided',
  };
  const className = styles[status] ?? 'border-border bg-muted text-muted-foreground';
  const label = labels[status] ?? `Invoice: ${status}`;
  return (
    <span
      className={`inline-flex h-5 items-center rounded-[3px] border px-2 text-[11px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}

function InfoRow({
  label,
  value,
  hideEmpty = false,
}: {
  readonly label: string;
  readonly value: string | null;
  /** Skip the row entirely when there is no value (intake fields). */
  readonly hideEmpty?: boolean;
}) {
  if (hideEmpty && value === null) return null;
  return (
    <div className="flex justify-between gap-4 py-1">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right text-sm font-medium">
        {value ?? <span className="text-muted-foreground italic">Not provided</span>}
      </span>
    </div>
  );
}

// Note timestamps read in the business timezone, like the rest of the sheet.
const NOTE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: BUSINESS_TIME_ZONE,
});

function TranscriptBubble({
  role,
  content,
  createdAt,
}: {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: string;
}) {
  if (role === 'system') {
    return (
      <div className="text-center py-1">
        <span className="text-xs italic text-muted-foreground">{content}</span>
      </div>
    );
  }

  const isUser = role === 'user';
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-info-light text-info-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        <p className={`mt-1 text-xs ${isUser ? 'text-info' : 'text-muted-foreground'}`}>
          {time}
        </p>
      </div>
    </div>
  );
}

// ── Visits ─────────────────────────────────────────────────────────────────

const VISIT_ERROR_COPY: Record<string, string> = {
  VERSION_CONFLICT: 'This visit changed. Reload and try again.',
  REQUEST_CANCELLED: 'This request is cancelled.',
  VISIT_CANCELLED: 'This visit is already cancelled.',
  IS_FIRST_VISIT: 'The first visit follows the request. Change the request instead.',
  TECHNICIAN_NOT_FOUND: 'One or more technicians aren’t active on your team.',
  TIME_OFF: 'One of those technicians is off during this window.',
  HAS_PROGRESS: 'A technician has already started this visit.',
  REQUEST_COMPLETED: 'This request is already completed.',
  VISIT_ENDED: 'This visit has ended. Add a new visit instead.',
  WINDOW_ENDED: 'That arrival window has already ended. Pick a later one.',
};
const VISIT_GENERIC_ERROR = 'Couldn’t save the visit. Try again.';

function visitWhen(a: AppointmentRecord): string {
  if (!a.arrivalWindowStart) {
    return a.scheduledDate ? formatIsoDayShort(a.scheduledDate.slice(0, 10)) : 'Not scheduled';
  }
  const start = new Date(a.arrivalWindowStart);
  const day = formatIsoDayShort(businessIsoDate(start));
  const row = windowRowOfInstant(start);
  return `${day} ${row ? WINDOW_LABELS[row] : formatBusinessTime(start)}`;
}

async function visitErrorFrom(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const code = body?.error?.code as string | undefined;
  return (code && VISIT_ERROR_COPY[code]) || VISIT_GENERIC_ERROR;
}

function VisitsSection({
  requestId,
  technicians,
  refreshKey,
  terminal,
  preferredDay,
  addSignal,
  prefillTechnicianIds,
  nextVisit,
  onChanged,
}: {
  readonly requestId: string;
  readonly technicians: readonly TechnicianRecord[];
  /** Changes when the request's status / technician / schedule changes, so visit #1 refetches. */
  readonly refreshKey: string;
  /** Completed or cancelled: no new visits. */
  readonly terminal: boolean;
  /** Business-tz day Add visit opens on (the request's own day), when it has one. */
  readonly preferredDay: string | null;
  /** Bumped by the sheet's "Schedule next visit" button to open the add dialog. */
  readonly addSignal: number;
  /** Technicians the add dialog starts with (the visit a hold ended). */
  readonly prefillTechnicianIds: readonly string[];
  /** A hold ended the visit: the add dialog is "Schedule next visit". */
  readonly nextVisit: boolean;
  /** A visit was added or cancelled: the request may have changed too. */
  readonly onChanged: () => void;
}) {
  const [visits, setVisits] = useState<readonly AppointmentRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [pick, setPick] = useState<WindowPickerValue | null>(null);
  const [techIds, setTechIds] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const availability = useAvailability(addOpen);

  const [cancelTarget, setCancelTarget] = useState<AppointmentRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Bumping `reload` refetches; the effect's own flag drops stale responses.
  const [reload, setReload] = useState(0);
  const load = useCallback(async (): Promise<void> => {
    setReload((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}/appointments`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body?.success) {
          setVisits(body.data.appointments as AppointmentRecord[]);
          setLoadFailed(false);
        } else {
          setLoadFailed(true);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, reload, refreshKey]);

  function openAdd(prefill: readonly string[] = []): void {
    setPick(null);
    setTechIds(prefill.slice(0, MAX_TECHNICIANS_PER_VISIT));
    setAddError(null);
    setAddOpen(true);
  }

  // "Schedule next visit" in the status row opens this dialog (adjusting state
  // during render on a prop change, not in an effect).
  const [seenSignal, setSeenSignal] = useState(addSignal);
  if (addSignal !== seenSignal) {
    setSeenSignal(addSignal);
    openAdd(prefillTechnicianIds);
  }

  function toggleTech(id: string): void {
    setTechIds((cur) =>
      cur.includes(id)
        ? cur.filter((t) => t !== id)
        : cur.length >= MAX_TECHNICIANS_PER_VISIT
          ? cur
          : [...cur, id],
    );
  }

  const chosenDay =
    pick?.isoDay ||
    initialVisitDay(preferredDay, availability.days, availability.windows, new Date());
  const canSave = !!pick?.window && !!chosenDay && techIds.length > 0 && !saving;

  async function saveVisit(): Promise<void> {
    if (!pick?.window || !chosenDay || techIds.length === 0) return;
    const { start, end } = arrivalWindowUtcForBusinessDate(chosenDay, pick.window as ArrivalWindow);
    setSaving(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/appointments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arrivalWindowStart: start.toISOString(),
          arrivalWindowEnd: end.toISOString(),
          technicianIds: techIds,
        }),
      });
      if (!res.ok) {
        setAddError(await visitErrorFrom(res));
        return;
      }
      setAddOpen(false);
      setNotice(null);
      await load();
      onChanged();
    } catch {
      setAddError('Could not connect to server.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelVisit(): Promise<void> {
    if (!cancelTarget) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(
        `/api/admin/requests/${requestId}/appointments/${cancelTarget.id}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: cancelTarget.version }),
        },
      );
      if (!res.ok) {
        const msg = await visitErrorFrom(res);
        // A stale version means the row moved on: reload it and say so.
        if (res.status === 409) {
          setCancelTarget(null);
          setNotice(msg);
          await load();
        } else {
          setCancelError(msg);
        }
        return;
      }
      setCancelTarget(null);
      setNotice(null);
      await load();
      onChanged();
    } catch {
      setCancelError('Could not connect to server.');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <SectionCard
        title="Visits"
        icon={CalendarClock}
        count={visits?.length}
        action={
          terminal ? undefined : (
            <Button type="button" size="sm" variant="outline" onClick={() => openAdd()}>
              Add visit
            </Button>
          )
        }
      >
        {notice && (
          <p role="alert" className="border-b px-4 py-2 text-sm text-warning-strong">
            {notice}
          </p>
        )}
        {visits === null && !loadFailed ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : loadFailed && visits === null ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            Couldn’t load visits.{' '}
            <button type="button" className="underline" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : visits && visits.length > 0 ? (
          <ul className="divide-y">
            {visits.map((a) => {
              const cancelled = a.cancelledAt !== null;
              // A live visit lists only technicians still on it; a cancelled one keeps its history.
              const names = a.assignments
                .filter((x) => cancelled || x.status !== 'cancelled')
                .map((x) => x.technicianName)
                .join(', ');
              return (
                <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className={cn('min-w-0', cancelled && 'text-muted-foreground line-through')}>
                    <p className="font-medium">
                      <span className="font-mono tabular-nums">#{a.appointmentNumber}</span>
                      {' · '}
                      {visitWhen(a)}
                      {a.appointmentNumber === 1 && (
                        <span className="font-normal text-muted-foreground"> (from the request)</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {names || 'No technician'} · {cancelled ? 'Cancelled' : a.isConfirmed ? 'Confirmed' : 'Not confirmed'}
                    </p>
                  </div>
                  {a.appointmentNumber > 1 && !cancelled && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCancelError(null);
                        setCancelTarget(a);
                      }}
                    >
                      Cancel visit
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No visits yet.</p>
        )}
      </SectionCard>

      <Dialog open={addOpen} onOpenChange={(o) => { if (!saving) setAddOpen(o); }}>
        <DialogContent className="max-h-[90vh] min-w-0 overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{nextVisit ? 'Schedule next visit' : 'Add visit'}</DialogTitle>
            <DialogDescription>
              Pick an arrival window and who is going. The first technician leads.
              {nextVisit && ' The request comes off hold once the visit is booked.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <WindowPicker
              value={{ isoDay: chosenDay, window: pick?.window ?? '', technicianId: '' }}
              onChange={setPick}
              days={availability.days}
              availability={availability.windows}
              isLoading={availability.isLoading}
              failed={availability.failed}
              idPrefix="av"
              emptyHint={null}
            />
            <div className="space-y-1.5">
              <p id="av-techs-label" className="text-sm font-medium">Technicians</p>
              <div role="group" aria-labelledby="av-techs-label" className="flex flex-wrap gap-1.5">
                {technicians.filter((t) => t.isActive).map((t) => {
                  const idx = techIds.indexOf(t.id);
                  const on = idx >= 0;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTech(t.id)}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring',
                        on ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent',
                      )}
                    >
                      {t.name}
                      {idx === 0 && <span className="ml-1 text-muted-foreground">(lead)</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Up to {MAX_TECHNICIANS_PER_VISIT}. {techIds.length === 0 ? 'Pick at least one.' : `${techIds.length} selected.`}
              </p>
            </div>
            {addError && (
              <p role="alert" className="text-sm text-danger">{addError}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveVisit()} disabled={!canSave}>
              {saving ? 'Adding…' : nextVisit ? 'Schedule visit' : 'Add visit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(o) => { if (!o && !cancelling) setCancelTarget(null); }}
        title={cancelTarget ? `Cancel visit #${cancelTarget.appointmentNumber}?` : 'Cancel visit?'}
        description="The visit is marked cancelled and its technicians are released. The request itself stays open."
        confirmLabel="Cancel visit"
        confirmingLabel="Cancelling…"
        cancelLabel="Keep visit"
        isConfirming={cancelling}
        error={cancelError}
        onConfirm={() => void cancelVisit()}
      />
    </>
  );
}

export function RequestDetailSheet({
  requestId,
  onClose,
  onAssigned,
}: RequestDetailSheetProps) {
  const [detail, setDetail] = useState<AdminRequestDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumped by the load error's Try again.
  const [detailReload, setDetailReload] = useState(0);

  const [technicians, setTechnicians] = useState<readonly TechnicianRecord[]>([]);
  const techniciansLoadedRef = useRef(false);

  const [selectedTechId, setSelectedTechId] = useState<string>('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Advisory top-3 scored suggestions (read-only; the human still commits).
  const [suggestions, setSuggestions] = useState<readonly DispatchSuggestion[]>([]);

  const [scheduledInput, setScheduledInput] = useState<string>('');
  const [arrivalWindowInput, setArrivalWindowInput] =
    useState<ArrivalWindow | null>(null);
  // Hold details appear only after "Put on hold" is chosen.
  const [holdOpen, setHoldOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [holdReasonInput, setHoldReasonInput] =
    useState<HoldReason>('awaiting_parts');
  const [followUpInput, setFollowUpInput] = useState<string>('');
  const [isPatching, setIsPatching] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  // Bumped by "Schedule next visit" to open the Visits section's add dialog.
  const [nextVisitSignal, setNextVisitSignal] = useState(0);

  const [noteInput, setNoteInput] = useState<string>('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Collapsible FieldPulse metrics — default open (high-value numbers).
  const [fpMetricsOpen, setFpMetricsOpen] = useState(true);

  // Recorded dispatch decision ("why this tech?") — null until fetched.
  const [decision, setDecision] = useState<DispatchDecisionView | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);

  const handleAddNote = useCallback(async (): Promise<void> => {
    if (!requestId) return;
    const content = noteInput.trim();
    if (!content) return;

    setIsAddingNote(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/admin/requests/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setNoteInput('');
        // Prepend the newly created note (server returns it with author name).
        const created = body.data as RequestNote;
        setDetail((prev) =>
          prev ? { ...prev, notes: [created, ...prev.notes] } : prev,
        );
      } else {
        setNoteError(body.error?.message ?? 'Couldn’t add the note. Please try again.');
      }
    } catch {
      setNoteError('Could not connect to server.');
    } finally {
      setIsAddingNote(false);
    }
  }, [requestId, noteInput]);

  // Re-read the request in place (no skeleton): after a visit is added or
  // cancelled, or when a write was refused because the request moved on.
  const refreshDetail = useCallback(async (): Promise<void> => {
    if (!requestId) return;
    try {
      const res = await fetch(`/api/admin/requests/${requestId}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) return;
      const next = body.data as AdminRequestDetail;
      if (next.id !== requestId) return;
      setDetail(next);
      const inputs = scheduleInputsFrom(next.scheduledDate, next.arrivalWindowStart, next.arrivalWindowEnd);
      setScheduledInput(inputs.date);
      setArrivalWindowInput(inputs.window);
      setSelectedTechId(next.assignedTo ?? '');
    } catch {
      // Keep what is on screen; the next open reloads it.
    }
  }, [requestId]);

  // Shared PATCH for status transitions and scheduled-date changes. Returns the
  // refreshed detail (server is the source of truth for derived fields like
  // completedAt) and surfaces a friendly error otherwise.
  const patchRequest = useCallback(
    async (payload: {
      status?: RequestStatus;
      scheduledDate?: string | null;
      arrivalWindow?: ArrivalWindow | null;
      holdReason?: HoldReason | null;
      followUpDate?: string | null;
    }): Promise<boolean> => {
      if (!requestId) return false;
      setIsPatching(true);
      setWorkflowError(null);
      try {
        const res = await fetch(`/api/admin/requests/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({ success: false }));
        if (res.ok && body.success) {
          const next = body.data as AdminRequestDetail;
          setDetail(next);
          // Re-derive the inputs from the server's truth so a Clear or Save
          // reflects what actually persisted (no optimistic divergence on error).
          const inputs = scheduleInputsFrom(next.scheduledDate, next.arrivalWindowStart, next.arrivalWindowEnd);
          setScheduledInput(inputs.date);
          setArrivalWindowInput(inputs.window);
          setHoldOpen(false);
          onAssigned(); // refresh the underlying list (status/schedule changed)
          return true;
        }
        setWorkflowError(body.error?.message ?? 'Couldn’t update the request. Please try again.');
        // 409: someone else moved the request first. Show its real state.
        if (res.status === 409) {
          setHoldOpen(false);
          void refreshDetail();
          onAssigned();
        }
        return false;
      } catch {
        setWorkflowError('Couldn’t reach the server. Please try again.');
        return false;
      } finally {
        setIsPatching(false);
      }
    },
    [requestId, onAssigned, refreshDetail],
  );

  // Fetch technician list (once)
  useEffect(() => {
    if (techniciansLoadedRef.current) return;
    techniciansLoadedRef.current = true;

    async function loadTechnicians(): Promise<void> {
      try {
        const res = await fetch('/api/admin/technicians');
        if (!res.ok) return;
        const body = (await res.json()) as {
          success: boolean;
          data: { technicians: TechnicianRecord[] };
        };
        if (body.success) {
          setTechnicians(body.data.technicians);
        }
      } catch {
        // Non-fatal: technician dropdown will be empty
      }
    }

    loadTechnicians();
  }, []);

  // Fetch request detail when requestId changes
  useEffect(() => {
    if (!requestId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    setIsLoadingDetail(true);
    setDetailError(null);
    setSelectedTechId('');
    setAssignError(null);
    setWorkflowError(null);
    setScheduledInput('');
    setArrivalWindowInput(null);
    setHoldOpen(false);
    setCancelConfirmOpen(false);
    setNoteInput('');
    setNoteError(null);

    // Cancellation guard: switching requests quickly can let request A's fetch
    // resolve AFTER B's, rendering A's data while every action button targets B.
    // Mirror the suggestions effect — ignore a stale response.
    let cancelled = false;
    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}`);
        if (cancelled) return;
        if (!res.ok) {
          if (cancelled) return;
          // Human copy, never the server's message.
          setDetailError(
            res.status === 404
              ? 'This request no longer exists or isn’t in your organization.'
              : 'Couldn’t load this request.',
          );
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: AdminRequestDetail;
        };
        if (cancelled) return;
        if (body.success) {
          setDetail(body.data);
          const inputs = scheduleInputsFrom(
            body.data.scheduledDate,
            body.data.arrivalWindowStart,
            body.data.arrivalWindowEnd,
          );
          setScheduledInput(inputs.date);
          setArrivalWindowInput(inputs.window);
          // Pre-select current technician if already assigned
          if (body.data.assignedTo) {
            setSelectedTechId(body.data.assignedTo);
          }
        }
      } catch {
        if (!cancelled) setDetailError('Couldn’t load this request.');
      } finally {
        if (!cancelled) setIsLoadingDetail(false);
      }
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [requestId, detailReload]);

  // Fetch advisory top-3 technician suggestions when the request changes.
  // Fail-open: any error leaves suggestions empty so the card simply hides — it
  // must never block or break the sheet.
  useEffect(() => {
    if (!requestId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    async function loadSuggestions(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/dispatch/suggest/${requestId}`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          success: boolean;
          data: { suggestions: DispatchSuggestion[] };
        };
        if (!cancelled && body.success) {
          setSuggestions(body.data.suggestions);
        }
      } catch {
        // Non-fatal: no suggestions card.
      }
    }
    setSuggestions([]);
    loadSuggestions();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  // Fetch the recorded dispatch decision ("why this tech?") when the request
  // changes. Fail-open: any error or 404 leaves decision null (section hidden).
  useEffect(() => {
    if (!requestId) {
      setDecision(null);
      return;
    }
    let cancelled = false;
    async function loadDecision(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}/decision`);
        if (!res.ok) {
          if (!cancelled) setDecision(null);
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: DispatchDecisionView | null;
        };
        if (!cancelled && body.success) setDecision(body.data ?? null);
      } catch {
        // Non-fatal: no decision section.
      }
    }
    setDecision(null);
    setDecisionOpen(false);
    void loadDecision();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  // A request that ALREADY HAS A TECHNICIAN is changed via REASSIGNMENT (PATCH),
  // which preserves the current status — so reassigning an on_hold or scheduled
  // job keeps its stage/hold state. Only a request with no assignee yet uses the
  // initial ASSIGNMENT (POST), which flips status to "assigned". (Keying off the
  // assignee rather than a status allowlist avoids the bug where reassigning an
  // on_hold/scheduled job via POST would silently reset it to "assigned".)
  const isReassignMode = Boolean(detail?.assignedTo);

  // Accepts an optional techId so a one-click suggestion assigns through the
  // SAME path as the dropdown; falls back to the dropdown selection otherwise.
  const handleAssign = useCallback(async (techIdArg?: string): Promise<void> => {
    const techId = techIdArg ?? selectedTechId;
    if (!requestId || !techId) return;

    setSelectedTechId(techId); // reflect the choice in the dropdown
    setIsAssigning(true);
    setAssignError(null);

    try {
      const method = isReassignMode ? 'PATCH' : 'POST';
      const res = await fetch(`/api/admin/requests/${requestId}/assign`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId: techId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAssignError(body?.error?.message ?? 'Couldn’t assign the technician. Please try again.');
        // The select goes back to who is really assigned, not the refused pick.
        setSelectedTechId(detail?.assignedTo ?? '');
        if (res.status === 409) void refreshDetail();
        return;
      }

      // Update local detail to reflect the (re)assignment. The server response
      // is the source of truth for status (preserved on reassign). Both POST
      // and PATCH return the lighter AdminRequest (list-item) shape.
      const body = (await res.json()) as {
        success: boolean;
        data: AdminRequest;
      };
      if (body.success && detail) {
        const assignedTech = technicians.find((t) => t.id === techId);
        setDetail({
          ...detail,
          assignedTo: techId,
          assignedToName: assignedTech?.name ?? 'Assigned',
          status: body.data.status,
        });
      }

      onAssigned();
    } catch {
      setAssignError('Could not connect to server.');
    } finally {
      setIsAssigning(false);
    }
  }, [requestId, selectedTechId, detail, technicians, onAssigned, isReassignMode, refreshDetail]);

  const activeTechnicians = technicians.filter((t) => t.isActive);
  // The visit the office shows as current — the same one the technician's phone shows.
  const visitView = detail ? sheetVisitView(detail) : null;
  const statusButtons = detail
    ? allowedTransitions(detail.status as RequestStatus).filter(
        (next) => !visitView?.hiddenTransitions.includes(next),
      )
    : [];
  const isTerminalStatus =
    detail?.status === 'completed' || detail?.status === 'cancelled';
  const scheduleCanSave = detail
    ? canSaveSchedule(
        scheduleInputsFrom(detail.scheduledDate, detail.arrivalWindowStart, detail.arrivalWindowEnd),
        { date: scheduledInput, window: arrivalWindowInput },
      )
    : false;
  const isOpen = requestId !== null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:w-[480px] sm:max-w-[480px] flex flex-col overflow-hidden">
        {isLoadingDetail ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detailError ? (
          <div className="p-4 pt-12">
            <SheetTitle className="sr-only">Request</SheetTitle>
            <LoadErrorState
              title={detailError}
              onRetry={() => setDetailReload((n) => n + 1)}
            />
          </div>
        ) : detail ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="font-mono text-sm">{detail.referenceNumber}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <UrgencyBadge urgency={detail.urgency} />
                <StatusBadge status={detail.status} />
                {detail.isAfterHours && (
                  <span className="inline-flex h-5 items-center rounded-[3px] border border-warning-border bg-warning-light px-2 text-[11px] font-medium text-warning-strong">
                    After-hours
                  </span>
                )}
                {detail.syncedSource && (
                  <SyncPill source={detail.syncedSource} size="md" />
                )}
                <InvoiceStatusBadge status={detail.invoiceStatus} />
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto space-y-4 px-4">
              {/* Customer info */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Customer information</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow label="Name" value={detail.customerName} />
                  {detail.customerPhone && <InfoRow label="Phone" value={detail.customerPhone} />}
                  {detail.customerEmail && <InfoRow label="Email" value={detail.customerEmail} />}
                  {detail.address && <InfoRow label="Address" value={detail.address} />}
                </div>
              </section>

              <VisitsSection
                key={detail.id}
                requestId={detail.id}
                technicians={technicians}
                refreshKey={[detail.status, detail.assignedTo, detail.arrivalWindowStart, detail.scheduledDate, detail.currentVisit.kind].join('|')}
                terminal={detail.status === 'completed' || detail.status === 'cancelled'}
                preferredDay={
                  scheduleInputsFrom(
                    visitView?.mode === 'request' ? detail.scheduledDate : null,
                    visitView?.arrivalWindowStart ?? null,
                    visitView?.arrivalWindowEnd ?? null,
                  ).date || null
                }
                addSignal={nextVisitSignal}
                prefillTechnicianIds={
                  detail.currentVisit.kind === 'ended' && detail.currentVisit.technicianId
                    ? [detail.currentVisit.technicianId]
                    : []
                }
                nextVisit={visitView?.mode === 'ended'}
                onChanged={() => {
                  void refreshDetail();
                  onAssigned();
                }}
              />

              <RequestFormsSection
                key={`forms-${detail.id}`}
                requestId={detail.id}
                requestStatus={detail.status}
                refreshKey={[detail.status, detail.currentVisit.kind].join('|')}
              />

              <section>
                <h3 className="text-sm font-semibold mb-2">Tags</h3>
                <TagChipPicker entity="job" entityId={detail.id} />
              </section>

              {/* Issue details */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Issue details</h3>
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Type</span>
                    <span className="text-sm font-medium">
                      {issueTypeLabel(detail.issueType)}
                    </span>
                  </div>
                  {detail.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {detail.description}
                    </p>
                  )}
                </div>
              </section>

              {/* FieldPulse operational metrics (only for enriched FP jobs).
                  Hidden entirely when all three metrics are empty. */}
              {detail.fieldpulseMetrics &&
                (detail.fieldpulseMetrics.totalPriceCents != null ||
                  (detail.fieldpulseMetrics.statusLogSeconds.on_the_way ?? 0) > 0 ||
                  (detail.fieldpulseMetrics.statusLogSeconds.in_progress ?? 0) > 0) && (
                <section>
                  <div className="rounded-md border border-border-strong bg-surface-sunken">
                    <button
                      type="button"
                      aria-expanded={fpMetricsOpen}
                      onClick={() => setFpMetricsOpen((v) => !v)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                    >
                      {fpMetricsOpen ? (
                        <ChevronDown className="size-3.5 shrink-0 text-foreground-faint motion-reduce:transition-none" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-foreground-faint motion-reduce:transition-none" aria-hidden="true" />
                      )}
                      <span className="rounded-[3px] border border-border-strong bg-surface-raised px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                        FieldPulse
                      </span>
                      <span>metrics</span>
                    </button>
                    {fpMetricsOpen && (
                      <div className="border-t border-border px-3 pb-3 pt-2 space-y-1">
                        {detail.fieldpulseMetrics.totalPriceCents != null && (
                          <InfoRow
                            label="Total price"
                            value={formatCentsExact(detail.fieldpulseMetrics.totalPriceCents)}
                          />
                        )}
                        {(detail.fieldpulseMetrics.statusLogSeconds.on_the_way ?? 0) > 0 && (
                          <InfoRow
                            label="Time on the way"
                            value={humanizeSeconds(detail.fieldpulseMetrics.statusLogSeconds.on_the_way)}
                          />
                        )}
                        {(detail.fieldpulseMetrics.statusLogSeconds.in_progress ?? 0) > 0 && (
                          <InfoRow
                            label="Time in progress"
                            value={humanizeSeconds(detail.fieldpulseMetrics.statusLogSeconds.in_progress)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* FieldPulse spillover details — collapsed; hidden when null */}
              {detail.fieldpulseData && (
                <section>
                  <FieldpulseDetails data={detail.fieldpulseData} />
                </section>
              )}

              {/* Intake details — everything the chat/voice agent captured.
                  Only shown when at least one field was filled in, so sparse
                  conversations don't render a wall of "Not provided" rows. */}
              {Object.values(detail.intake).some((v) => v !== null) && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Intake details</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow hideEmpty
                    label="System"
                    value={humanizeIntakeValue(
                      detail.intake.systemType,
                      SYSTEM_TYPE_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Job type"
                    value={humanizeIntakeValue(
                      detail.intake.jobType,
                      JOB_TYPE_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Equipment age"
                    value={humanizeIntakeValue(
                      detail.intake.equipmentAgeBand,
                      EQUIPMENT_AGE_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty label="Brand" value={detail.intake.equipmentBrand} />
                  <InfoRow hideEmpty
                    label="Property"
                    value={humanizeIntakeValue(
                      detail.intake.propertyType,
                      PROPERTY_TYPE_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Owner / Renter"
                    value={humanizeIntakeValue(
                      detail.intake.ownerOccupant,
                      OWNER_OCCUPANT_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Warranty"
                    value={humanizeIntakeValue(
                      detail.intake.underWarranty,
                      WARRANTY_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="System status"
                    value={humanizeIntakeValue(
                      detail.intake.systemDownStatus,
                      SYSTEM_STATUS_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Duration"
                    value={detail.intake.problemDuration}
                  />
                  <InfoRow hideEmpty
                    label="Vulnerable occupants"
                    value={boolLabel(detail.intake.vulnerableOccupants)}
                  />
                  <InfoRow hideEmpty
                    label="Preferred window"
                    value={humanizeIntakeValue(
                      detail.intake.preferredWindow,
                      PREFERRED_WINDOW_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="Contact preference"
                    value={humanizeIntakeValue(
                      detail.intake.contactPreference,
                      CONTACT_PREFERENCE_LABELS,
                    )}
                  />
                  <InfoRow hideEmpty
                    label="SMS consent"
                    value={boolLabel(detail.intake.smsConsent)}
                  />
                  <InfoRow hideEmpty
                    label="Lead source"
                    value={humanizeIntakeValue(
                      detail.intake.leadSource,
                      LEAD_SOURCE_LABELS,
                    )}
                  />
                  {/* Access notes can be long — give it a stacked block rather
                      than the inline two-column InfoRow layout. */}
                  {detail.intake.accessNotes && (
                    <div className="pt-2">
                      <span className="text-sm text-muted-foreground">
                        Access notes
                      </span>
                      <p className="mt-1 whitespace-pre-wrap text-sm font-medium">
                        {detail.intake.accessNotes}
                      </p>
                    </div>
                  )}
                </div>
              </section>
              )}

              {/* Assignment — hidden for terminal requests (completed/
                  cancelled), where neither assign nor reassign is permitted. */}
              {detail.status !== 'completed' &&
                detail.status !== 'cancelled' && visitView && !visitView.requestControls && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Assignment</h3>
                <div className="rounded-md border p-3 space-y-2">
                  {visitView.technicianName && (
                    <p className="text-sm">
                      {visitView.mode === 'ended' ? 'The ended visit was booked with ' : 'Currently assigned to: '}
                      <span className="font-medium">{visitView.technicianName}</span>
                    </p>
                  )}
                  {visitView.mode === 'visit' && (
                    <p className="text-xs text-muted-foreground">{visitView.notice}</p>
                  )}
                </div>
              </section>
              )}
              {detail.status !== 'completed' &&
                detail.status !== 'cancelled' && visitView?.requestControls && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Assignment</h3>
                <div className="rounded-md border p-3 space-y-3">
                  {suggestions.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Suggested technicians
                      </span>
                      {suggestions.map((s) => {
                        const name =
                          activeTechnicians.find((t) => t.id === s.technicianId)
                            ?.name ?? 'Technician';
                        const isCurrent = s.technicianId === detail.assignedTo;
                        return (
                          <div
                            key={s.technicianId}
                            className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface-sunken p-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{name}</p>
                              <p className="text-xs text-muted-foreground">
                                {s.reasons.join(' · ')}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isAssigning || isCurrent}
                              onClick={() => handleAssign(s.technicianId)}
                            >
                              {isCurrent ? 'Assigned' : 'Assign'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {detail.assignedToName && (
                    <p className="text-sm">
                      Currently assigned to:{' '}
                      <span className="font-medium">{detail.assignedToName}</span>
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedTechId}
                      onValueChange={(value) => setSelectedTechId(value ?? '')}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select technician" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeTechnicians.map((tech) => (
                          <SelectItem key={tech.id} value={tech.id}>
                            {tech.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => handleAssign()}
                      disabled={
                        !selectedTechId ||
                        isAssigning ||
                        // In reassign mode, disable until a DIFFERENT tech is
                        // picked — reassigning to the same person is a no-op.
                        (isReassignMode && selectedTechId === detail.assignedTo)
                      }
                    >
                      {isAssigning
                        ? isReassignMode
                          ? 'Reassigning…'
                          : 'Assigning…'
                        : isReassignMode
                          ? 'Reassign'
                          : 'Assign'}
                    </Button>
                  </div>
                  {assignError && (
                    <p role="alert" className="text-xs text-destructive">{assignError}</p>
                  )}
                </div>
              </section>
              )}

              {/* Dispatch decision — collapsible "why this tech?" panel.
                  Hidden when no decision row has been recorded yet. */}
              {decision && (
                <section>
                  <div className="rounded-md border border-info-border bg-info-light">
                    <button
                      type="button"
                      aria-expanded={decisionOpen}
                      onClick={() => setDecisionOpen((v) => !v)}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-foreground transition-colors duration-[var(--dur-hover)] hover:text-info-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    >
                      {decisionOpen ? (
                        <ChevronDown className="size-3.5 shrink-0 text-info-strong" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-info-strong" aria-hidden="true" />
                      )}
                      <span>Dispatch decision</span>
                      {decision.isShadow && (
                        <span className="rounded-[3px] border border-info-border bg-surface-raised px-1.5 py-px text-[10px] font-medium text-info-strong">
                          preview
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {decision.outcome}
                      </span>
                    </button>
                    {decisionOpen && (
                      <div className="border-t border-info-border px-3 pb-3 pt-2 space-y-2">
                        <div className="text-xs text-muted-foreground">
                          {decision.topScore != null && (
                            <>top score {decision.topScore.toFixed(2)}</>
                          )}
                          {decision.confidenceGap != null && (
                            <> · gap {decision.confidenceGap.toFixed(2)}</>
                          )}
                          {decision.overriddenAt && <> · overridden by dispatcher</>}
                        </div>
                        <ul className="space-y-1.5">
                          {decision.candidates.map((c) => (
                            <li key={c.technicianId} className="text-xs">
                              <span className="font-medium text-foreground">
                                {c.name ?? c.technicianId}
                              </span>{' '}
                              · {c.score.toFixed(2)}
                              {c.travelMinutes != null
                                ? ` · ~${Math.round(c.travelMinutes)} min`
                                : c.travelKm != null
                                  ? ` · ${c.travelKm.toFixed(1)} km`
                                  : ''}
                              <div className="text-muted-foreground">
                                {c.reasons.join(' · ')}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Status & scheduling */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Status &amp; scheduling</h3>
                <div className="rounded-md border p-3 space-y-3">
                  {isTerminalStatus ? (
                    <p className="text-sm text-muted-foreground">
                      {detail.status === 'cancelled'
                        ? 'This request is cancelled.'
                        : 'This request is complete.'}{' '}
                      No further changes.
                    </p>
                  ) : (
                  <div className="space-y-2">
                    {visitView?.mode === 'ended' && (
                      <p className="text-sm">{visitView.notice}</p>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {visitView?.mode === 'ended' ? 'Next step:' : 'Move this request to:'}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {visitView?.mode === 'ended' && (
                        <Button
                          size="sm"
                          disabled={isPatching}
                          onClick={() => setNextVisitSignal((n) => n + 1)}
                        >
                          Schedule next visit
                        </Button>
                      )}
                      {statusButtons.map(
                        (next, index) => (
                          <Button
                            key={next}
                            size="sm"
                            // One filled button per row: the first forward step
                            // (none when "Schedule next visit" leads).
                            variant={
                              index === 0 &&
                              visitView?.mode !== 'ended' &&
                              next !== 'cancelled' &&
                              next !== 'on_hold'
                                ? 'default'
                                : 'outline'
                            }
                            aria-expanded={next === 'on_hold' ? holdOpen : undefined}
                            disabled={isPatching}
                            onClick={() => {
                              if (next === 'on_hold') {
                                setHoldOpen((v) => !v);
                              } else if (next === 'cancelled') {
                                setWorkflowError(null);
                                setCancelConfirmOpen(true);
                              } else {
                                void patchRequest({ status: next });
                              }
                            }}
                          >
                            {STATUS_ACTION_LABELS[
                              next as ManualTargetStatus
                            ] ?? next}
                          </Button>
                        ),
                      )}
                    </div>

                    {/* Hold details — only after "Put on hold" is chosen. */}
                    {holdOpen && (
                      <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="space-y-1">
                            <span className="block text-xs text-muted-foreground">Reason</span>
                            <select
                              value={holdReasonInput}
                              onChange={(e) =>
                                setHoldReasonInput(e.target.value as HoldReason)
                              }
                              className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {HOLD_REASONS.map((r) => (
                                <option key={r} value={r}>
                                  {HOLD_REASON_LABELS[r]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1">
                            <span className="block text-xs text-muted-foreground">
                              Follow up on (optional)
                            </span>
                            <input
                              type="date"
                              value={followUpInput}
                              onChange={(e) => setFollowUpInput(e.target.value)}
                              className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={isPatching}
                            onClick={() =>
                              void patchRequest({
                                status: 'on_hold',
                                holdReason: holdReasonInput,
                                followUpDate: followUpInput
                                  ? new Date(
                                      `${followUpInput}T00:00:00.000Z`,
                                    ).toISOString()
                                  : null,
                              })
                            }
                          >
                            {isPatching ? 'Saving…' : 'Put on hold'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPatching}
                            onClick={() => setHoldOpen(false)}
                          >
                            Back
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* When already on hold, show what it's waiting on. */}
                    {detail.status === 'on_hold' && detail.holdReason && (
                      <p className="text-xs text-muted-foreground">
                        On hold:{' '}
                        <span className="font-medium text-foreground">
                          {HOLD_REASON_LABELS[detail.holdReason as HoldReason] ??
                            detail.holdReason}
                        </span>
                        {detail.followUpDate && (
                          <>
                            {' '}· follow up{' '}
                            {/* The follow-up is a UTC-midnight calendar date;
                                render it in UTC so it doesn't slip a day west of UTC. */}
                            {new Date(detail.followUpDate).toLocaleDateString(
                              undefined,
                              { timeZone: 'UTC' },
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  )}

                  <div className="space-y-2">
                    {!isTerminalStatus && visitView?.requestControls && (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Scheduled service date &amp; arrival window:
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="date"
                            aria-label="Scheduled service date"
                            value={scheduledInput}
                            onChange={(e) => setScheduledInput(e.target.value)}
                            className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                          <select
                            aria-label="Arrival window"
                            value={arrivalWindowInput ?? ''}
                            onChange={(e) =>
                              setArrivalWindowInput(
                                e.target.value ? (e.target.value as ArrivalWindow) : null,
                              )
                            }
                            className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {arrivalWindowInput === null && (
                              <option value="">Choose a window</option>
                            )}
                            {ARRIVAL_WINDOWS.map((w) => (
                              <option key={w} value={w}>
                                {ARRIVAL_WINDOW_LABELS[w]}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            disabled={isPatching || !scheduleCanSave}
                            onClick={() => {
                              if (!arrivalWindowInput) return;
                              void patchRequest({
                                // The route reads the day part as a business date.
                                scheduledDate: new Date(
                                  `${scheduledInput}T00:00:00.000Z`,
                                ).toISOString(),
                                arrivalWindow: arrivalWindowInput,
                              });
                            }}
                          >
                            Save
                          </Button>
                          {detail.scheduledDate && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isPatching}
                              onClick={() =>
                                void patchRequest({
                                  scheduledDate: null,
                                  arrivalWindow: null,
                                })
                              }
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                    {formatArrivalWindow(
                      visitView?.arrivalWindowStart ?? null,
                      visitView?.arrivalWindowEnd ?? null,
                    ) && (
                      <p className="text-xs text-muted-foreground">
                        {visitView?.mode === 'ended' ? 'Ended visit:' : 'Arrival window:'}{" "}
                        <span
                          className={cn(
                            'font-medium text-foreground',
                            visitView?.mode === 'ended' && 'text-muted-foreground line-through',
                          )}
                        >
                          {formatArrivalWindow(
                            visitView?.arrivalWindowStart ?? null,
                            visitView?.arrivalWindowEnd ?? null,
                          )}
                        </span>
                      </p>
                    )}
                  </div>

                  {workflowError && !cancelConfirmOpen && (
                    <p role="alert" className="text-xs text-destructive">{workflowError}</p>
                  )}
                </div>
                <ConfirmDialog
                  open={cancelConfirmOpen}
                  onOpenChange={(o) => { if (!o && !isPatching) setCancelConfirmOpen(false); }}
                  title="Cancel this request?"
                  description={cancelRequestDescription(Boolean(detail.assignedTo))}
                  confirmLabel="Cancel request"
                  confirmingLabel="Cancelling…"
                  cancelLabel="Keep request"
                  isConfirming={isPatching}
                  error={cancelConfirmOpen ? workflowError : null}
                  onConfirm={() => {
                    void patchRequest({ status: 'cancelled' }).then((ok) => {
                      if (ok) setCancelConfirmOpen(false);
                    });
                  }}
                />
              </section>

              {/* Internal notes */}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  Internal notes ({detail.notes.length})
                </h3>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <textarea
                      aria-label="Internal note"
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      placeholder="Add an internal note (not visible to the customer)…"
                      rows={2}
                      maxLength={5000}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex items-center justify-between">
                      {noteError ? (
                        <p role="alert" className="text-xs text-destructive">{noteError}</p>
                      ) : (
                        <span />
                      )}
                      <Button
                        size="sm"
                        disabled={isAddingNote || !noteInput.trim()}
                        onClick={handleAddNote}
                      >
                        {isAddingNote ? 'Adding…' : 'Add note'}
                      </Button>
                    </div>
                  </div>

                  {detail.notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No internal notes yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {detail.notes.map((note) => (
                        <div key={note.id} className="rounded-md border p-3">
                          <p className="whitespace-pre-wrap text-sm">
                            {note.content}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {note.authorName ?? 'System'} ·{' '}
                            {NOTE_TIME_FORMAT.format(new Date(note.createdAt))}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <Separator />

              {/* Estimates */}
              <section>
                <ScopedEstimatesSection
                  serviceRequestId={detail.id}
                  variant="plain"
                />
              </section>

              <Separator />

              {/* Invoices */}
              <section>
                <ScopedInvoicesSection
                  serviceRequestId={detail.id}
                  variant="plain"
                />
              </section>

              <Separator />

              {/* Attachments */}
              <section>
                <AttachmentsSection serviceRequestId={detail.id} />
              </section>

              <Separator />

              {/* Transcript */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Conversation transcript</h3>
                <ScrollArea className="max-h-[300px] rounded-md border p-3">
                  {detail.transcript.length === 0 ? (
                    detail.syncedSource === 'fieldpulse' ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        Imported from FieldPulse — no conversation transcript
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No messages recorded
                      </p>
                    )
                  ) : (
                    detail.transcript.map((msg, index) => (
                      <TranscriptBubble
                        key={`${msg.createdAt}-${index}`}
                        role={msg.role}
                        content={msg.content}
                        createdAt={msg.createdAt}
                      />
                    ))
                  )}
                </ScrollArea>
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
