'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { AlertTriangle, CalendarClock, ChevronDown, Search, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WindowPicker, useAvailability } from '@/components/admin/window-picker';
import { TagChipPicker } from '@/components/admin/tag-chip-picker';
import { useAdminTechnicians } from '@/hooks/use-admin-technicians';
import { issueTypeValues, jobTypeValues, urgencyValues } from '@/lib/ai/extraction-schema';
import {
  DESCRIPTION_MAX,
  ISSUE_TYPE_LABELS,
  JOB_TYPE_LABELS,
  URGENCY_LABELS,
  buildCreateRequestPayload,
  firstInvalidField,
  firstOpenDay,
  pruneFixedErrors,
  isDraftDirty,
  type CreateRequestDraft,
} from '@/lib/admin/create-request';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import type { ContactRecord } from '@/lib/admin/contact-types';
import type { JobTypeRecord } from '@/lib/admin/job-type-types';
import type { CustomerLocation } from '@/lib/admin/location-queries';
import { cn } from '@/lib/utils';
import { customerNameLabel } from '@/lib/admin/customer-name-display';

interface RequestCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the new request's id once it is saved. */
  readonly onCreated: (requestId: string) => void;
  /** Expand the schedule panel when the dialog opens (setup-guide deep link). */
  readonly initialScheduleOpen?: boolean;
}

type FieldErrors = Partial<Record<'customer' | 'address' | 'issueType' | 'description', string>>;

const NO_CONTACT = '__no_contact__';
const SEARCH_LIMIT = 5;

const EMPTY_DRAFT: CreateRequestDraft = {
  customerId: null,
  newCustomer: { name: '', phone: '', email: '' },
  address: '',
  issueType: '',
  jobType: '',
  jobTypeId: '',
  contactId: '',
  locationId: '',
  tagTypeIds: [],
  urgency: 'medium',
  description: '',
  accessNotes: '',
  scheduleOpen: false,
  isoDay: '',
  window: '',
  technicianId: '',
};

const ISSUE_ITEMS = issueTypeValues.map((v) => ({ value: v, label: ISSUE_TYPE_LABELS[v] }));
const JOB_TYPE_ITEMS = [
  { value: '', label: 'Match the issue' },
  ...jobTypeValues.map((v) => ({ value: v, label: JOB_TYPE_LABELS[v] })),
];
const URGENCY_ITEMS = urgencyValues.map((v) => ({ value: v, label: URGENCY_LABELS[v] }));

function validate(draft: CreateRequestDraft, newCustomerMode: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.customerId && !(newCustomerMode && draft.newCustomer.name.trim())) {
    errors.customer = newCustomerMode ? 'Enter the customer’s name.' : 'Pick a customer or add a new one.';
  }
  if (!draft.address.trim()) errors.address = 'Enter the service address.';
  if (!draft.issueType) errors.issueType = 'Pick what the issue is.';
  if (!draft.description.trim()) errors.description = 'Describe the job.';
  return errors;
}

/** Debounced customer search against /api/admin/customers?search=. */
function useCustomerSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<readonly CustomerListRecord[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const q = query.trim();
  const active = enabled && q.length >= 2;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setIsSearching(true);
      setFailed(false);
      try {
        const res = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body?.success) {
          setResults((body.data.customers as CustomerListRecord[]).slice(0, SEARCH_LIMIT));
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, active]);

  return { results: active ? results : [], isSearching: active && isSearching, failed, active };
}

/** GET a list out of the `{ success, data }` envelope; null on any failure. */
async function fetchList<T>(url: string, key: string): Promise<readonly T[] | null> {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) return null;
    return (body.data[key] as T[]) ?? null;
  } catch {
    return null;
  }
}

/** Active job types, fetched each time the dialog opens. */
function useJobTypes(open: boolean) {
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchList<JobTypeRecord>('/api/admin/settings/job-types?active=1', 'jobTypes').then((list) => {
      if (!cancelled && list) setJobTypes(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return jobTypes;
}

/** Contacts + service locations of the picked customer. */
function useCustomerExtras(
  customerId: string | null,
  onLocations: (locations: readonly CustomerLocation[]) => void,
) {
  const [loaded, setLoaded] = useState<{
    readonly customerId: string;
    readonly contacts: readonly ContactRecord[];
    readonly locations: readonly CustomerLocation[];
  } | null>(null);
  const onLocationsRef = useRef(onLocations);
  useEffect(() => {
    onLocationsRef.current = onLocations;
  });

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    void Promise.all([
      fetchList<ContactRecord>(`/api/admin/customers/${customerId}/contacts`, 'contacts'),
      fetchList<CustomerLocation>(`/api/admin/customers/${customerId}/locations`, 'locations'),
    ]).then(([contacts, locations]) => {
      if (cancelled) return;
      setLoaded({ customerId, contacts: contacts ?? [], locations: locations ?? [] });
      if (locations) onLocationsRef.current(locations);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const fresh = loaded && loaded.customerId === customerId ? loaded : null;
  return { contacts: fresh?.contacts ?? [], locations: fresh?.locations ?? [] };
}

function FieldError({ id, message }: { readonly id: string; readonly message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-danger">
      {message}
    </p>
  );
}

export function RequestCreateDialog({
  open,
  onOpenChange,
  onCreated,
  initialScheduleOpen,
}: RequestCreateDialogProps) {
  const [draft, setDraft] = useState<CreateRequestDraft>(EMPTY_DRAFT);
  const [pickedCustomer, setPickedCustomer] = useState<CustomerListRecord | null>(null);
  const [newCustomerMode, setNewCustomerMode] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  // Time off is never overridable, so its conflict hides "Schedule anyway".
  const [conflict, setConflict] = useState<{ message: string; overridable: boolean } | null>(null);
  const [notice, setNotice] = useState<{ id: string; message: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const search = useCustomerSearch(searchInput, open && !pickedCustomer && !newCustomerMode);
  const availability = useAvailability(open && draft.scheduleOpen);
  const [urgencyTouched, setUrgencyTouched] = useState(false);
  const jobTypes = useJobTypes(open);
  const extras = useCustomerExtras(draft.customerId, (locations) => {
    // Default the service location to the customer's primary one. Its address
    // replaces the form's only while that is empty or still the customer's
    // prefilled address, so a typed address is never clobbered and the saved
    // location always matches the address shown.
    const primary = locations.find((l) => l.isPrimary);
    if (!primary) return;
    const prefilled = (pickedCustomer?.address ?? '').trim();
    setDraft((d) => {
      if (d.locationId) return d;
      const untouched = !d.address.trim() || d.address.trim() === prefilled;
      if (!untouched) return d;
      return { ...d, locationId: primary.id, address: primary.address ?? d.address };
    });
  });
  const jobTypeItems = useMemo(
    () => [
      { value: '', label: 'Auto (match the issue)' },
      ...jobTypes.map((jt) => ({ value: jt.id, label: jt.name })),
    ],
    [jobTypes],
  );
  const contactItems = useMemo(
    () => [
      { value: NO_CONTACT, label: 'No specific contact' },
      ...extras.contacts.map((c) => ({ value: c.id, label: c.role ? `${c.name} (${c.role})` : c.name })),
    ],
    [extras.contacts],
  );
  const locationItems = useMemo(
    () =>
      extras.locations.map((l) => ({
        value: l.id,
        label: [l.label, l.address].filter(Boolean).join(' · ') || 'Unnamed location',
      })),
    [extras.locations],
  );
  const { technicians } = useAdminTechnicians();
  const activeTechs = useMemo(() => technicians.filter((t) => t.isActive), [technicians]);

  // Until the dispatcher picks a day, default to the first day with an opening.
  const selectedDay = draft.isoDay || firstOpenDay(availability.days, availability.windows, new Date());

  function patch(p: Partial<CreateRequestDraft>): void {
    setDraft((d) => ({ ...d, ...p }));
    setConflict(null);
  }

  function reset(): void {
    setDraft({ ...EMPTY_DRAFT, scheduleOpen: initialScheduleOpen ?? false });
    setPickedCustomer(null);
    setNewCustomerMode(false);
    setSearchInput('');
    setErrors({});
    setServerError(null);
    setConflict(null);
    setNotice(null);
    setUrgencyTouched(false);
  }

  // Start fresh on each open (not on close, so the form doesn't blank out
  // while the dialog animates away). State adjustment during render, per
  // https://react.dev/learn/you-might-not-need-an-effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }

  function close(): void {
    if (submittingRef.current) return;
    setDiscardOpen(false);
    onOpenChange(false);
  }

  // Esc, the X, the backdrop and Cancel ask first when something was entered.
  const [discardOpen, setDiscardOpen] = useState(false);
  function requestClose(): void {
    if (submittingRef.current) return;
    if (!notice && isDraftDirty(draft, searchInput)) {
      setDiscardOpen(true);
      return;
    }
    close();
  }

  function pickCustomer(c: CustomerListRecord): void {
    setPickedCustomer(c);
    setDraft((d) => ({
      ...d,
      customerId: c.id,
      // Prefill the service address from the customer, without clobbering one
      // the dispatcher already typed.
      address: d.address.trim() ? d.address : (c.address ?? ''),
    }));
    setErrors((e) => ({ ...e, customer: undefined }));
  }

  function clearCustomer(): void {
    setPickedCustomer(null);
    setDraft((d) => ({ ...d, customerId: null, contactId: '', locationId: '' }));
  }

  async function submit(override: boolean): Promise<void> {
    setServerError(null);
    const found = validate(draft, newCustomerMode);
    setErrors(found);
    const firstInvalid = firstInvalidField(found);
    if (firstInvalid) {
      // Move focus to the first field that needs fixing (after the render that shows its message).
      requestAnimationFrame(() => {
        const selector: Record<typeof firstInvalid, string> = {
          customer: newCustomerMode ? '#nr-name' : 'input[aria-label="Search customers"]',
          address: '#nr-address',
          issueType: '[aria-labelledby="nr-issue-label"]',
          description: '#nr-description',
        };
        document.querySelector<HTMLElement>(`#new-request-form ${selector[firstInvalid]}`)?.focus();
      });
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCreateRequestPayload({ ...draft, isoDay: selectedDay }, override)),
      });
      const body = await res.json().catch(() => null);
      const code = body?.error?.code;
      if (res.status === 409 && (code === 'SCHEDULE_CONFLICT' || code === 'TIME_OFF')) {
        setConflict({ message: body.error.message as string, overridable: code === 'SCHEDULE_CONFLICT' });
        return;
      }
      if (!res.ok || !body?.success) {
        // Validation copy from the server is written for people; anything
        // else gets the generic line.
        setServerError(
          res.status === 400 || res.status === 422
            ? (body?.error?.message as string) ?? 'Couldn’t save the request. Please try again.'
            : 'Couldn’t save the request. Please try again.',
        );
        return;
      }
      const requestId = body.data.requestId as string;
      const ref = body.data.referenceNumber as string;
      if (body.data.schedule?.kind === 'failed') {
        // The request exists; only the time slot was taken meanwhile.
        onCreated(requestId);
        setNotice({
          id: requestId,
          message: `Request ${ref} was saved, but that time was just taken. Schedule it from the request.`,
        });
        return;
      }
      onCreated(requestId);
      submittingRef.current = false;
      close();
    } catch {
      setServerError('Couldn’t reach the server. Please try again.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  const customerErrorId = 'new-request-customer-error';
  // A message from the last submit stays only while its field is still wrong.
  const shownErrors = pruneFixedErrors(errors, validate(draft, newCustomerMode));

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>Book a request for a customer. Scheduling is optional.</DialogDescription>
        </DialogHeader>

        {notice ? (
          <div className="space-y-3">
            <InfoLine tone="warning">{notice.message}</InfoLine>
          </div>
        ) : (
          <form
            id="new-request-form"
            className="min-w-0 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            {/* ── Customer ── */}
            <fieldset className="min-w-0 space-y-2">
              <legend className="mb-2 text-sm font-medium">Customer</legend>
              {pickedCustomer ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{customerNameLabel(pickedCustomer.name)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {pickedCustomer.phone ?? pickedCustomer.email ?? 'No contact on file'}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={clearCustomer}>
                    Change
                  </Button>
                </div>
              ) : newCustomerMode ? (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="nr-name">Name</Label>
                    <Input
                      id="nr-name"
                      value={draft.newCustomer.name}
                      onChange={(e) => patch({ newCustomer: { ...draft.newCustomer, name: e.target.value } })}
                      aria-invalid={Boolean(shownErrors.customer)}
                      aria-describedby={shownErrors.customer ? customerErrorId : undefined}
                      placeholder="Jordan Smith"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="nr-phone">Phone</Label>
                      <Input
                        id="nr-phone"
                        type="tel"
                        value={draft.newCustomer.phone}
                        onChange={(e) => patch({ newCustomer: { ...draft.newCustomer, phone: e.target.value } })}
                        placeholder="(423) 555-0100"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="nr-email">Email</Label>
                      <Input
                        id="nr-email"
                        type="email"
                        value={draft.newCustomer.email}
                        onChange={(e) => patch({ newCustomer: { ...draft.newCustomer, email: e.target.value } })}
                        placeholder="name@example.com"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A matching phone or email links this to the existing customer.
                  </p>
                  <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setNewCustomerMode(false)}>
                    Search existing customers instead
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      placeholder="Search by name, phone, email or address"
                      aria-label="Search customers"
                      aria-invalid={Boolean(shownErrors.customer)}
                      aria-describedby={shownErrors.customer ? customerErrorId : undefined}
                      className="pl-9"
                      autoFocus
                    />
                  </div>
                  {search.active && (
                    <div className="rounded-md border" aria-live="polite">
                      {search.isSearching && search.results.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
                      ) : search.failed ? (
                        <p className="px-3 py-2 text-sm text-danger">Couldn’t search customers. Please try again.</p>
                      ) : search.results.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-muted-foreground">
                          No customers match “{searchInput.trim()}”.
                        </p>
                      ) : (
                        <ul className="divide-y">
                          {search.results.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => pickCustomer(c)}
                                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                              >
                                <span className="truncate font-medium">{customerNameLabel(c.name)}</span>
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                  {c.phone ?? c.email ?? ''}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNewCustomerMode(true);
                      // Carry a typed name over so it isn't retyped.
                      if (searchInput.trim() && !/\d|@/.test(searchInput)) {
                        patch({ newCustomer: { ...draft.newCustomer, name: searchInput.trim() } });
                      }
                    }}
                  >
                    <UserPlus className="mr-1.5 size-3.5" />
                    New customer
                  </Button>
                </div>
              )}
              <FieldError id={customerErrorId} message={shownErrors.customer} />
            </fieldset>

            {/* ── Job ── */}
            <fieldset className="min-w-0 space-y-3">
              <legend className="mb-2 text-sm font-medium">Job</legend>
              <div className="space-y-1.5">
                <Label htmlFor="nr-address">Service address</Label>
                <Input
                  id="nr-address"
                  value={draft.address}
                  onChange={(e) => patch({ address: e.target.value, locationId: '' })}
                  aria-invalid={Boolean(shownErrors.address)}
                  aria-describedby={shownErrors.address ? 'nr-address-error' : undefined}
                  placeholder="123 Main St, Johnson City, TN 37601"
                  autoComplete="off"
                />
                <FieldError id="nr-address-error" message={shownErrors.address} />
              </div>
              {draft.customerId && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label id="nr-contact-label">Contact (optional)</Label>
                    <Select
                      items={contactItems}
                      value={draft.contactId || NO_CONTACT}
                      onValueChange={(v) => patch({ contactId: !v || v === NO_CONTACT ? '' : v })}
                    >
                      <SelectTrigger className="w-full" aria-labelledby="nr-contact-label">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {contactItems.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {locationItems.length > 0 && (
                    <div className="space-y-1.5">
                      <Label id="nr-location-label">Service location</Label>
                      <Select
                        items={locationItems}
                        value={draft.locationId}
                        onValueChange={(v) => {
                          const loc = extras.locations.find((l) => l.id === v);
                          patch({ locationId: v ?? '', ...(loc?.address ? { address: loc.address } : {}) });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-labelledby="nr-location-label">
                          <SelectValue placeholder="Pick a location" />
                        </SelectTrigger>
                        <SelectContent>
                          {locationItems.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label id="nr-issue-label">Issue</Label>
                  <Select
                    items={ISSUE_ITEMS}
                    value={draft.issueType}
                    onValueChange={(v) => {
                      patch({ issueType: v ?? '' });
                      setErrors((e) => ({ ...e, issueType: undefined }));
                    }}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-labelledby="nr-issue-label"
                      aria-invalid={Boolean(shownErrors.issueType)}
                    >
                      <SelectValue placeholder="Pick one" />
                    </SelectTrigger>
                    <SelectContent>
                      {ISSUE_ITEMS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError id="nr-issue-error" message={shownErrors.issueType} />
                </div>
                <div className="space-y-1.5">
                  <Label id="nr-jobtype-label">Job type</Label>
                  <Select
                    items={jobTypes.length > 0 ? jobTypeItems : JOB_TYPE_ITEMS}
                    value={jobTypes.length > 0 ? draft.jobTypeId : draft.jobType}
                    onValueChange={(v) => {
                      const id = v ?? '';
                      if (jobTypes.length === 0) {
                        patch({ jobType: id });
                        return;
                      }
                      const picked = jobTypes.find((jt) => jt.id === id);
                      patch({
                        jobTypeId: id,
                        jobType: '',
                        ...(picked && !urgencyTouched ? { urgency: picked.defaultPriority } : {}),
                      });
                    }}
                  >
                    <SelectTrigger className="w-full" aria-labelledby="nr-jobtype-label">
                      <SelectValue placeholder="Auto (match the issue)" />
                    </SelectTrigger>
                    <SelectContent>
                      {(jobTypes.length > 0 ? jobTypeItems : JOB_TYPE_ITEMS).map((o) => (
                        <SelectItem key={o.value || 'auto'} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label id="nr-urgency-label">Urgency</Label>
                  <Select items={URGENCY_ITEMS} value={draft.urgency} onValueChange={(v) => {
                      setUrgencyTouched(true);
                      patch({ urgency: v ?? 'medium' });
                    }}>
                    <SelectTrigger className="w-full" aria-labelledby="nr-urgency-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {URGENCY_ITEMS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nr-description">Description</Label>
                <Textarea
                  id="nr-description"
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  aria-invalid={Boolean(shownErrors.description)}
                  aria-describedby={shownErrors.description ? 'nr-description-error' : undefined}
                  placeholder="What the customer reported"
                />
                <FieldError id="nr-description-error" message={shownErrors.description} />
              </div>
              <div className="space-y-1.5">
                <Label>Tags</Label>
                <TagChipPicker
                  entity="job"
                  entityId={null}
                  value={draft.tagTypeIds ?? []}
                  onChange={(ids) => patch({ tagTypeIds: ids })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nr-access">Access notes</Label>
                <Input
                  id="nr-access"
                  value={draft.accessNotes}
                  onChange={(e) => patch({ accessNotes: e.target.value })}
                  placeholder="Gate code, pets, parking…"
                  maxLength={1000}
                />
              </div>
            </fieldset>

            {/* ── Schedule (optional) ── */}
            <fieldset className="min-w-0 space-y-3">
              <legend className="sr-only">Schedule</legend>
              <button
                type="button"
                aria-expanded={draft.scheduleOpen}
                aria-controls="nr-schedule-panel"
                onClick={() => patch({ scheduleOpen: !draft.scheduleOpen })}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="flex items-center gap-2 font-medium">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  {draft.scheduleOpen ? 'Schedule now' : 'Leave unscheduled'}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {draft.scheduleOpen ? 'Hide' : 'Pick a time'}
                  <ChevronDown className={cn('size-4 transition-transform', draft.scheduleOpen && 'rotate-180')} />
                </span>
              </button>

              {draft.scheduleOpen && (
                <div id="nr-schedule-panel" className="space-y-3 rounded-md border p-3">
                  <WindowPicker
                    value={{ isoDay: selectedDay, window: draft.window, technicianId: draft.technicianId }}
                    onChange={(v) => patch({ isoDay: v.isoDay, window: v.window, technicianId: v.technicianId })}
                    days={availability.days}
                    availability={availability.windows}
                    technicians={activeTechs}
                    isLoading={availability.isLoading}
                    failed={availability.failed}
                  />
                </div>
              )}
            </fieldset>

            {conflict && (
              <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                <p className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  {conflict.message}
                </p>
                <div className="flex gap-2">
                  {conflict.overridable && (
                    <Button type="button" size="sm" onClick={() => void submit(true)} disabled={isSubmitting}>
                      Schedule anyway
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={() => setConflict(null)}>
                    Pick another time
                  </Button>
                </div>
              </div>
            )}
          </form>
        )}

        <DialogFooter>
          {notice ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={requestClose}>
                Cancel
              </Button>
              <Button type="submit" form="new-request-form" disabled={isSubmitting || Boolean(conflict)}>
                {isSubmitting ? 'Saving…' : 'Create request'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this request?"
        description="What you’ve entered will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={close}
      />
    </Dialog>
  );
}

function InfoLine({ tone, children }: { readonly tone: 'warning'; readonly children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md border p-3 text-sm',
        tone === 'warning' && 'border-warning/40 bg-warning/10',
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      {children}
    </p>
  );
}

