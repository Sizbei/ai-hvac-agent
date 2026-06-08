'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import {
  allowedTransitions,
  MANUAL_TARGET_STATUSES,
  type RequestStatus,
} from '@/lib/admin/request-status';
import type {
  AdminRequest,
  AdminRequestDetail,
  TechnicianRecord,
  RequestNote,
} from '@/lib/admin/types';

// Only manual targets can ever be a transition button — narrowing the map to
// those keys makes any drift from the state machine a compile error rather than
// dead code.
type ManualTargetStatus = (typeof MANUAL_TARGET_STATUSES)[number];

const STATUS_ACTION_LABELS: Record<ManualTargetStatus, string> = {
  in_progress: 'Start work',
  completed: 'Mark complete',
  cancelled: 'Cancel',
};

// HTML <input type="date"> wants YYYY-MM-DD; convert an ISO timestamp to that.
function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

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

function InfoRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">
        {value ?? <span className="text-muted-foreground italic">Not provided</span>}
      </span>
    </div>
  );
}

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
            ? 'bg-blue-100 text-blue-900'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        <p className={`mt-1 text-xs ${isUser ? 'text-blue-500' : 'text-gray-400'}`}>
          {time}
        </p>
      </div>
    </div>
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

  const [technicians, setTechnicians] = useState<readonly TechnicianRecord[]>([]);
  const techniciansLoadedRef = useRef(false);

  const [selectedTechId, setSelectedTechId] = useState<string>('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [scheduledInput, setScheduledInput] = useState<string>('');
  const [isPatching, setIsPatching] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  const [noteInput, setNoteInput] = useState<string>('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

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
        setNoteError(body.error?.message ?? 'Failed to add note');
      }
    } catch {
      setNoteError('Could not connect to server.');
    } finally {
      setIsAddingNote(false);
    }
  }, [requestId, noteInput]);

  // Shared PATCH for status transitions and scheduled-date changes. Returns the
  // refreshed detail (server is the source of truth for derived fields like
  // completedAt) and surfaces a friendly error otherwise.
  const patchRequest = useCallback(
    async (payload: {
      status?: RequestStatus;
      scheduledDate?: string | null;
    }): Promise<void> => {
      if (!requestId) return;
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
          // Re-derive the date input from the server's truth so a Clear or Save
          // reflects what actually persisted (no optimistic divergence on error).
          setScheduledInput(toDateInputValue(next.scheduledDate));
          onAssigned(); // refresh the underlying list (status/schedule changed)
        } else {
          setWorkflowError(body.error?.message ?? 'Update failed');
        }
      } catch {
        setWorkflowError('Could not connect to server.');
      } finally {
        setIsPatching(false);
      }
    },
    [requestId, onAssigned],
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
    setNoteInput('');
    setNoteError(null);

    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({
            error: { message: 'Failed to load request details' },
          }));
          setDetailError(body?.error?.message ?? 'Failed to load request details');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: AdminRequestDetail;
        };
        if (body.success) {
          setDetail(body.data);
          setScheduledInput(toDateInputValue(body.data.scheduledDate));
          // Pre-select current technician if already assigned
          if (body.data.assignedTo) {
            setSelectedTechId(body.data.assignedTo);
          }
        }
      } catch {
        setDetailError('Could not connect to server.');
      } finally {
        setIsLoadingDetail(false);
      }
    }

    loadDetail();
  }, [requestId]);

  // "assigned"/"in_progress" already have work in flight, so changing the
  // technician is a REASSIGNMENT (PATCH) that preserves status; "pending" is an
  // initial ASSIGNMENT (POST) that flips status to "assigned".
  const isReassignMode =
    detail?.status === 'assigned' || detail?.status === 'in_progress';

  const handleAssign = useCallback(async (): Promise<void> => {
    if (!requestId || !selectedTechId) return;

    setIsAssigning(true);
    setAssignError(null);

    try {
      const method = isReassignMode ? 'PATCH' : 'POST';
      const res = await fetch(`/api/admin/requests/${requestId}/assign`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId: selectedTechId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Assignment failed' },
        }));
        setAssignError(body?.error?.message ?? 'Assignment failed');
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
        const assignedTech = technicians.find((t) => t.id === selectedTechId);
        setDetail({
          ...detail,
          assignedTo: selectedTechId,
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
  }, [requestId, selectedTechId, detail, technicians, onAssigned, isReassignMode]);

  const formatIssueType = (issueType: string): string =>
    issueType
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

  const activeTechnicians = technicians.filter((t) => t.isActive);
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
          <div className="p-4">
            <p className="text-sm text-destructive">{detailError}</p>
          </div>
        ) : detail ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="font-mono text-sm">{detail.referenceNumber}</span>
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <UrgencyBadge urgency={detail.urgency} />
                <StatusBadge status={detail.status} />
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto space-y-4 px-4">
              {/* Customer info */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Customer Information</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow label="Name" value={detail.customerName} />
                  <InfoRow label="Phone" value={detail.customerPhone} />
                  <InfoRow label="Email" value={detail.customerEmail} />
                  <InfoRow label="Address" value={detail.address} />
                </div>
              </section>

              {/* Issue details */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Issue Details</h3>
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Type</span>
                    <span className="text-sm font-medium">
                      {formatIssueType(detail.issueType)}
                    </span>
                  </div>
                  {detail.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {detail.description}
                    </p>
                  )}
                </div>
              </section>

              {/* Intake details — everything the chat/voice agent captured.
                  Only shown when at least one field was filled in, so sparse
                  conversations don't render a wall of "Not provided" rows. */}
              {Object.values(detail.intake).some((v) => v !== null) && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Intake Details</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow
                    label="System"
                    value={humanizeIntakeValue(
                      detail.intake.systemType,
                      SYSTEM_TYPE_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Job type"
                    value={humanizeIntakeValue(
                      detail.intake.jobType,
                      JOB_TYPE_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Equipment age"
                    value={humanizeIntakeValue(
                      detail.intake.equipmentAgeBand,
                      EQUIPMENT_AGE_LABELS,
                    )}
                  />
                  <InfoRow label="Brand" value={detail.intake.equipmentBrand} />
                  <InfoRow
                    label="Property"
                    value={humanizeIntakeValue(
                      detail.intake.propertyType,
                      PROPERTY_TYPE_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Owner / Renter"
                    value={humanizeIntakeValue(
                      detail.intake.ownerOccupant,
                      OWNER_OCCUPANT_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Warranty"
                    value={humanizeIntakeValue(
                      detail.intake.underWarranty,
                      WARRANTY_LABELS,
                    )}
                  />
                  <InfoRow
                    label="System status"
                    value={humanizeIntakeValue(
                      detail.intake.systemDownStatus,
                      SYSTEM_STATUS_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Duration"
                    value={detail.intake.problemDuration}
                  />
                  <InfoRow
                    label="Vulnerable occupants"
                    value={boolLabel(detail.intake.vulnerableOccupants)}
                  />
                  <InfoRow
                    label="Preferred window"
                    value={humanizeIntakeValue(
                      detail.intake.preferredWindow,
                      PREFERRED_WINDOW_LABELS,
                    )}
                  />
                  <InfoRow
                    label="Contact preference"
                    value={humanizeIntakeValue(
                      detail.intake.contactPreference,
                      CONTACT_PREFERENCE_LABELS,
                    )}
                  />
                  <InfoRow
                    label="SMS consent"
                    value={boolLabel(detail.intake.smsConsent)}
                  />
                  <InfoRow
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
                detail.status !== 'cancelled' && (
              <section>
                <h3 className="text-sm font-semibold mb-2">Assignment</h3>
                <div className="rounded-md border p-3 space-y-3">
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
                      onClick={handleAssign}
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
                          ? 'Reassigning...'
                          : 'Assigning...'
                        : isReassignMode
                          ? 'Reassign'
                          : 'Assign'}
                    </Button>
                  </div>
                  {assignError && (
                    <p className="text-xs text-destructive">{assignError}</p>
                  )}
                </div>
              </section>
              )}

              {/* Status & scheduling */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Status &amp; Scheduling</h3>
                <div className="rounded-md border p-3 space-y-3">
                  <div className="space-y-2">
                    <span className="text-xs text-muted-foreground">
                      Move this request to:
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {allowedTransitions(detail.status as RequestStatus)
                        .length === 0 ? (
                        <span className="text-sm text-muted-foreground italic">
                          No further status changes available.
                        </span>
                      ) : (
                        allowedTransitions(detail.status as RequestStatus).map(
                          (next) => (
                            <Button
                              key={next}
                              size="sm"
                              variant={
                                next === 'cancelled' ? 'outline' : 'default'
                              }
                              disabled={isPatching}
                              onClick={() => patchRequest({ status: next })}
                            >
                              {STATUS_ACTION_LABELS[
                                next as ManualTargetStatus
                              ] ?? next}
                            </Button>
                          ),
                        )
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs text-muted-foreground">
                      Scheduled service date:
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={scheduledInput}
                        onChange={(e) => setScheduledInput(e.target.value)}
                        className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <Button
                        size="sm"
                        disabled={isPatching || !scheduledInput}
                        onClick={() =>
                          patchRequest({
                            // Anchor the chosen calendar day at UTC midnight.
                            scheduledDate: new Date(
                              `${scheduledInput}T00:00:00.000Z`,
                            ).toISOString(),
                          })
                        }
                      >
                        Save
                      </Button>
                      {detail.scheduledDate && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPatching}
                          onClick={() => patchRequest({ scheduledDate: null })}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>

                  {workflowError && (
                    <p className="text-xs text-destructive">{workflowError}</p>
                  )}
                </div>
              </section>

              {/* Internal notes */}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  Internal Notes ({detail.notes.length})
                </h3>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <textarea
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      placeholder="Add an internal note (not visible to the customer)..."
                      rows={2}
                      maxLength={5000}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex items-center justify-between">
                      {noteError ? (
                        <p className="text-xs text-destructive">{noteError}</p>
                      ) : (
                        <span />
                      )}
                      <Button
                        size="sm"
                        disabled={isAddingNote || !noteInput.trim()}
                        onClick={handleAddNote}
                      >
                        {isAddingNote ? 'Adding...' : 'Add Note'}
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
                            {new Date(note.createdAt).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <Separator />

              {/* Transcript */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Conversation Transcript</h3>
                <ScrollArea className="max-h-[300px] rounded-md border p-3">
                  {detail.transcript.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No messages recorded
                    </p>
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
