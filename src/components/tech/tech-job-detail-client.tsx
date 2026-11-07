'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { EstimatesCard } from '@/components/tech/estimates/estimates-card';
import { EquipmentCard } from '@/components/tech/equipment/equipment-card';
import { FormsCard } from '@/components/tech/forms/forms-card';
import { SiteCard } from '@/components/tech/site/site-card';
import { cardVisit, fillHref } from '@/lib/tech/form-copy';
import { unsubmittedRequired, type TechFormsView } from '@/lib/tech/form-view';
import { materialOverlapWarning, soldPricebookItemIds } from '@/lib/tech/material-overlap';
import type { TechEstimatesView } from '@/lib/tech/estimate-view';
import { TechJobSummary, type SummaryLoaded } from '@/components/tech/tech-job-summary';
import { SignaturePad } from '@/components/tech/signature-pad';
import { JobTimeCard } from '@/components/tech/job-time-card';
import { JobPhotosCard } from '@/components/tech/job-photos-card';
import { statusLabel, visitWhen } from '@/lib/tech/job-display';
import { mintKey } from '@/lib/http/idempotency-codes';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { outcomeEvent, type WriteOutcome } from '@/lib/tech/invoice-key-state';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { SIGNATURE_DIDNT_SAVE } from '@/lib/tech/approval-flow';
import { jobIsClosed, lateMaterialWarning } from '@/components/tech/tech-status-confirm';
import { parseManualPrice } from '@/lib/tech/material-form';
import {
  JOB_NOT_FOUND,
  JOB_NOT_FOUND_BACK,
  type JobLoadOutcome,
} from '@/lib/tech/job-page-state';

interface Material {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly unitPriceCents: number;
  /** On a non-void native invoice of the request. */
  readonly onInvoice: boolean;
}

const JOB_CLOSED_COPY = 'This job is closed. Ask the office to add parts.';

interface PricebookItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly priceCents: number;
}

interface TimelineEntry {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly at: string;
}

/** "Nov 4, 2:05 PM" in the device's locale. */
function formatSignedAt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface SignatureBody {
  readonly blob: Blob;
  readonly name: string;
}

/** Copy for a signature write that did not land: one message, never server text. */
function signatureErrorCopy(outcome: WriteOutcome): string {
  if (outcome === 'wait_then_refetch') return 'Still saving your last tap. Try again in a moment.';
  return SIGNATURE_DIDNT_SAVE;
}

export function TechJobDetailClient({
  id,
  appointmentId,
}: {
  readonly id: string;
  readonly appointmentId?: string;
}) {
  // 'not_found' (404/400 from the summary) replaces the whole page with one state.
  const [jobOutcome, setJobOutcome] = useState<JobLoadOutcome | null>(null);
  // A completed or cancelled request takes no new parts or signature; notes
  // and photos stay allowed. Until the summary says which, no form renders.
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [invoiceState, setInvoiceState] = useState<string | null>(null);
  // M3d: the Forms card's visit (spec §7.2) and its view, for the close-out reminder.
  // undefined = the summary hasn't said yet (the card shows a skeleton, not "No visit on this job yet.").
  const [formsVisit, setFormsVisit] = useState<string | null | undefined>(appointmentId ?? undefined);
  const [formsView, setFormsView] = useState<TechFormsView | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const onSummaryLoaded = useCallback((outcome: JobLoadOutcome, job: SummaryLoaded | null) => {
    setJobOutcome(outcome);
    setSummaryFailed(outcome === 'error');
    if (job) {
      setJobStatus(job.status);
      setInvoiceState(job.invoiceState);
      setFormsVisit(cardVisit(appointmentId, job.assignmentVisitId, job.activeVisitId));
    }
  }, [appointmentId]);
  const known = jobStatus !== null;
  const closed = jobIsClosed(jobStatus);
  const editable = known && !closed;
  const [materials, setMaterials] = useState<Material[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // A load failure must NOT masquerade as an empty job (no materials / not
  // clocked in) — surface it so the tech doesn't re-add duplicates or assume
  // they're off the clock. Either the materials or timesheet fetch can set it.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Time on this job: read-only, driven by status taps.
  const [openSince, setOpenSince] = useState<string | null>(null);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [closedEntries, setClosedEntries] = useState(0);
  const [timeLoaded, setTimeLoaded] = useState(false);

  // Material add form
  const [catalog, setCatalog] = useState<PricebookItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Note
  const [note, setNote] = useState('');
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const [isPostingNote, setIsPostingNote] = useState(false);

  // Signature: the pad holds one PNG per intent; this reducer holds its key. A
  // retry re-sends the same Blob with the same key (the server replays); a new
  // capture (redraw / name edit) mints a new key; a success spends it.
  const { state: sigState, dispatch: sigDispatch } = useIdempotencyKey({ intentId: 'signature', requestId: id, persist: false });
  const blobIds = useRef(new WeakMap<Blob, string>());
  const [sigError, setSigError] = useState<string | undefined>(undefined);
  const [sigSaved, setSigSaved] = useState(false);
  // undefined = not loaded yet; null = unsigned.
  const [signedAt, setSignedAt] = useState<string | null | undefined>(undefined);
  const [signAgain, setSignAgain] = useState(false);
  const [padKey, setPadKey] = useState(0);

  // Status timeline (read-only history of this job's transitions).
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  // A status tap can open or close selling and equipment: both cards refetch on it.
  const [refreshKey, setRefreshKey] = useState(0);
  const [estimatesView, setEstimatesView] = useState<TechEstimatesView | null>(null);
  const onEstimatesLoaded = useCallback((v: TechEstimatesView | null) => setEstimatesView(v), []);

  const loadMaterials = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/materials`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setMaterials(body.data.materials);
        setLoadError(null);
      } else {
        setLoadError("Couldn't load this job's materials.");
      }
    } catch {
      setLoadError("Couldn't load this job's materials.");
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadMaterials();
  }, [loadMaterials]);

  const loadTimeline = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/timeline`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setTimeline(body.data.timeline);
      }
      // A timeline read failure is non-critical — the section just stays empty;
      // it never blocks the rest of the job detail.
    } catch {
      /* non-critical */
    }
  }, [id]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const loadTimesheet = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/timesheet`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setOpenSince(body.data.open ? body.data.open.clockInAt : null);
        setTotalMinutes(typeof body.data.totalMinutes === 'number' ? body.data.totalMinutes : 0);
        setClosedEntries(typeof body.data.closedEntries === 'number' ? body.data.closedEntries : 0);
        setTimeLoaded(true);
      } else {
        setLoadError("Couldn't load this job's timesheet.");
      }
    } catch {
      setLoadError("Couldn't load this job's timesheet.");
    }
  }, [id]);

  useEffect(() => {
    void loadTimesheet();
  }, [loadTimesheet]);

  // Load the pricebook once for catalog selection. Uses the TECH-scoped endpoint
  // (the admin one 401s for a technician session, so the catalog stayed empty and
  // catalog materials could never be added).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tech/pricebook');
        const body = await res.json().catch(() => ({ success: false }));
        if (cancelled) return;
        if (res.ok && body.success) setCatalog(body.data.items);
      } catch {
        // Non-fatal: the manual-description path still works; catalog stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdd = useCallback(async (): Promise<void> => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setAddError('Quantity must be a whole number ≥ 1.');
      return;
    }
    if (!selectedItemId && !manualDesc.trim()) {
      setAddError('Pick a catalog item or enter a description.');
      return;
    }
    const price = selectedItemId ? null : parseManualPrice(manualPrice, qty);
    if (price && !price.ok) {
      setAddError(price.message);
      return;
    }
    setIsAdding(true);
    setAddError(null);
    try {
      const payload = selectedItemId
        ? { pricebookItemId: selectedItemId, quantity: qty }
        : {
            description: manualDesc.trim(),
            quantity: qty,
            ...(price?.ok && price.cents !== null ? { unitPriceCents: price.cents } : {}),
          };
      const res = await fetch(`/api/tech/jobs/${id}/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setSelectedItemId('');
        setManualDesc('');
        setManualPrice('');
        setQuantity('1');
        setSearch('');
        void loadMaterials();
      } else if (body?.error?.code === 'JOB_CLOSED') {
        setAddError(JOB_CLOSED_COPY);
      } else {
        setAddError("Couldn't add that material. Check it and try again.");
      }
    } catch {
      setAddError("Couldn't reach the server. Try again.");
    } finally {
      setIsAdding(false);
    }
  }, [id, quantity, selectedItemId, manualDesc, manualPrice, loadMaterials]);

  const handleRemove = useCallback(
    async (materialId: string): Promise<void> => {
      const res = await fetch(
        `/api/tech/jobs/${id}/materials?materialId=${materialId}`,
        { method: 'DELETE' },
      );
      if (res.ok) void loadMaterials();
    },
    [id, loadMaterials],
  );

  const handlePostNote = useCallback(async (): Promise<void> => {
    if (!note.trim()) return;
    setIsPostingNote(true);
    setNoteStatus(null);
    try {
      const res = await fetch(`/api/tech/jobs/${id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: note.trim() }),
      });
      if (res.ok) {
        setNote('');
        setNoteStatus('Note saved.');
      } else {
        setNoteStatus('Failed to save note.');
      }
    } catch {
      setNoteStatus('Could not connect to server.');
    } finally {
      setIsPostingNote(false);
    }
  }, [id, note]);

  /** The job's signedAt from the summary GET; undefined when it couldn't load. */
  const loadSignedAt = useCallback(async (): Promise<string | null | undefined> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        const value: string | null = body.data.signedAt ?? null;
        setSignedAt(value);
        return value;
      }
    } catch {
      /* fall through: shown as unsigned */
    }
    setSignedAt((prev) => (prev === undefined ? null : prev));
    return undefined;
  }, [id]);

  useEffect(() => {
    void loadSignedAt();
  }, [loadSignedAt]);

  const handleCapture = useCallback(
    async (blob: Blob, name: string): Promise<void> => {
      let blobId = blobIds.current.get(blob);
      if (!blobId) {
        blobId = mintKey();
        blobIds.current.set(blob, blobId);
      }
      const bodyHash = `${blobId}|${name}`;
      const body: SignatureBody = { blob, name };
      const arm = { bodyHash, body, mint: mintKey };
      let s = sigDispatch({ type: 'open', ...arm });
      if (s.phase === 'unknown' && s.bodyHash !== bodyHash) {
        // A new capture after an unanswered send: the job signature is always
        // re-capturable, so drop the old intent rather than re-send it.
        sigDispatch({ type: 'dropped' });
        s = sigDispatch({ type: 'open', ...arm });
      }
      // Gate on the EDIT result: `sent + sent` is a no-op still in `sent`, so
      // only armed (first send) or unknown (re-send) may go out.
      const pre = sigDispatch({ type: 'edit', ...arm });
      if (pre.phase !== 'armed' && pre.phase !== 'unknown') return;
      s = sigDispatch({ type: 'sent' });
      if (s.phase !== 'sent') return;
      const toSend = s.body as SignatureBody;
      const before = signedAt;
      setSigError(undefined);
      setSigSaved(false);

      let status: number | null = null;
      let code: string | null = null;
      let details: { storedStatus?: number } | undefined;
      try {
        const form = new FormData();
        form.append('file', new File([toSend.blob], 'signature.png', { type: 'image/png' }));
        form.append('signatureName', toSend.name);
        const res = await fetch(`/api/tech/jobs/${id}/signature`, {
          method: 'POST',
          headers: { 'Idempotency-Key': s.key },
          body: form,
        });
        if (res.ok) {
          sigDispatch({ type: 'spent' });
          await loadSignedAt();
          setSignAgain(false);
          setPadKey((k) => k + 1);
          setSigSaved(true);
          return;
        }
        status = res.status;
        const err = await res.json().catch(() => ({}));
        code = err?.error?.code ?? null;
        details = err?.error?.details;
      } catch {
        /* network error: status stays null */
      }

      const outcome = classifyWriteError(status, code, details);
      if (outcome === 'wait_then_refetch') await new Promise((r) => setTimeout(r, 2000));
      const now = await loadSignedAt();
      const advanced = typeof now === 'string' && now !== before;
      const ev = outcomeEvent(outcome, advanced);
      if (ev) sigDispatch({ type: ev });
      if (advanced) {
        setSignAgain(false);
        setPadKey((k) => k + 1);
        setSigSaved(true);
        return;
      }
      setSigError(signatureErrorCopy(outcome));
    },
    [id, sigDispatch, signedAt, loadSignedAt],
  );

  const unbilledParts = isLoading ? 0 : materials.filter((m) => !m.onInvoice).length;
  const formReminders = formsView
    ? unsubmittedRequired(formsView).map((f) => ({ name: f.name, href: fillHref(id, f.formId, formsView.visitId) }))
    : [];
  const lateWarning = lateMaterialWarning(invoiceState);
  const overlapWarning = materialOverlapWarning(soldPricebookItemIds(estimatesView), selectedItemId);

  const filteredCatalog = search.trim()
    ? catalog.filter((c) =>
        c.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : catalog;

  if (jobOutcome === 'not_found') {
    return (
      <Card>
        <CardContent className="space-y-4 py-6">
          <p role="alert" className="text-[17px] font-medium">
            {JOB_NOT_FOUND}
          </p>
          <Link
            href="/tech/jobs"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium text-foreground active:bg-accent"
          >
            <ArrowLeft className="size-4" /> {JOB_NOT_FOUND_BACK}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Link
        href="/tech/jobs"
        className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link"
      >
        <ArrowLeft className="size-4" /> Back
      </Link>

      {/* All info the tech needs on-site + status controls. */}
      <TechJobSummary
        id={id}
        appointmentId={appointmentId}
        unbilledParts={unbilledParts}
        formReminders={formReminders}
        onLoaded={onSummaryLoaded}
        onStatusChanged={() => {
          // A status tap opens or closes the job clock: reload both.
          void loadTimeline();
          void loadTimesheet();
          setRefreshKey((k) => k + 1);
        }}
      />
      <FormsCard jobId={id} visitId={formsVisit} summaryFailed={summaryFailed} closed={closed} refreshKey={refreshKey} onLoaded={setFormsView} />
      <SiteCard jobId={id} />
      <EstimatesCard jobId={id} refreshKey={refreshKey} onLoaded={onEstimatesLoaded} />

      {loadError && (
        <div
          role="alert"
          className="rounded-md border border-danger-border bg-danger-light px-3 py-2 text-[15px] text-danger-strong"
        >
          {loadError} Some data may be missing — pull to refresh or reopen the job.
        </div>
      )}

      {/* Time on this job (read-only: status taps are the job clock) */}
      <JobTimeCard
        openSince={openSince}
        totalMinutes={totalMinutes}
        closedEntries={closedEntries}
        jobClosed={closed}
        loaded={timeLoaded}
      />

      {/* Materials used */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Materials used</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : materials.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              No materials recorded yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {materials.map((m) => (
                <li
                  key={m.id}
                  className="flex min-h-11 items-center justify-between gap-2 text-[15px]"
                >
                  <span className="min-w-0">
                    {m.description ?? 'Material'}
                    {m.quantity > 1 ? ` × ${m.quantity}` : ''}
                    {!m.onInvoice && (
                      <span className="ml-2 inline-block rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[13px] font-medium whitespace-nowrap text-warning-strong">
                        Not on an invoice
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[14px] tabular-nums text-foreground">
                      {formatCentsExact(m.unitPriceCents * m.quantity)}
                    </span>
                    {editable && (
                    <button
                      type="button"
                      aria-label="Remove material"
                      onClick={() => void handleRemove(m.id)}
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-foreground-faint active:bg-danger-light active:text-danger-strong"
                    >
                      <Trash2 className="size-4" />
                    </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Add material: only once the summary says the job is open. */}
          {editable && (
          <div className="space-y-2 border-t border-border pt-3">
            <Input
              placeholder="Search pricebook…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 rounded-xl text-[15px] md:text-[15px]"
            />
            <select
              aria-label="Pricebook item (or choose manual entry)"
              value={selectedItemId}
              onChange={(e) => {
                setSelectedItemId(e.target.value);
                if (e.target.value) setManualDesc('');
              }}
              className="flex h-11 w-full rounded-xl border border-border-input bg-surface-raised px-3 text-[15px] text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              <option value="">— Manual entry —</option>
              {filteredCatalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {!selectedItemId && (
              <>
                <Input
                  placeholder="Manual description"
                  value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  className="h-11 rounded-xl text-[15px] md:text-[15px]"
                />
                <label className="flex items-center gap-2">
                  <span className="shrink-0 text-[15px] text-muted-foreground">Price each $</span>
                  <Input
                    aria-label="Price each, in dollars (optional)"
                    placeholder="Optional"
                    inputMode="decimal"
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                    className="h-11 rounded-xl font-mono text-[15px] tabular-nums md:text-[15px]"
                  />
                </label>
              </>
            )}
            {lateWarning && (
              <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px] text-foreground">
                {lateWarning}
              </p>
            )}
            {overlapWarning && (
              <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px] text-foreground">
                {overlapWarning}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                aria-label="Quantity"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="h-11 w-20 rounded-xl font-mono text-[15px] tabular-nums md:text-[15px]"
              />
              <Button
                className="h-11 rounded-xl px-4 text-[15px]"
                disabled={isAdding}
                onClick={() => void handleAdd()}
              >
                {isAdding ? 'Adding…' : 'Add'}
              </Button>
            </div>
            {addError && (
              <p className="text-[13px] text-danger-strong">{addError}</p>
            )}
          </div>
          )}
        </CardContent>
      </Card>

      <EquipmentCard jobId={id} refreshKey={refreshKey} />

      {/* On-site note (saved notes go to the office; a late note on a closed job is fine) */}
      {known && (
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">On-site note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="What you found / did on-site…"
            className="rounded-xl text-[15px] md:text-[15px]"
          />
          <Button
            className="h-11 rounded-xl px-4 text-[15px]"
            disabled={isPostingNote || !note.trim()}
            onClick={() => void handlePostNote()}
          >
            {isPostingNote ? 'Saving…' : 'Save note'}
          </Button>
          {noteStatus && (
            <p className="text-[13px] text-muted-foreground">{noteStatus}</p>
          )}
        </CardContent>
      </Card>
      )}

      {/* Customer signature */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Customer signature</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {signedAt === undefined || !known ? (
            <Skeleton className="h-[140px] w-full rounded-xl" />
          ) : closed ? (
            <p className="text-[15px] text-muted-foreground">
              {signedAt ? `Signed ${formatSignedAt(signedAt)}` : 'No signature.'}
            </p>
          ) : signedAt && !signAgain ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px]">Signed {formatSignedAt(signedAt)}</p>
              <Button
                variant="outline"
                className="h-11 rounded-xl px-4 text-[15px]"
                onClick={() => {
                  setSignAgain(true);
                  setSigSaved(false);
                }}
              >
                Sign again
              </Button>
            </div>
          ) : (
            <SignaturePad
              key={padKey}
              onCapture={handleCapture}
              disabled={sigState.phase === 'sent'}
              error={sigError}
            />
          )}
          {sigSaved && (
            <p role="status" className="text-[13px] text-muted-foreground">
              Signature saved.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Job photos */}
      <JobPhotosCard jobId={id} readOnly={!known} />

      {/* Status timeline (read-only history) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Status history</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              No status changes yet.
            </p>
          ) : (
            <ol className="space-y-2">
              {timeline.map((e, i) => (
                <li
                  key={i}
                  className="flex items-baseline justify-between gap-3 text-[15px]"
                >
                  <span>
                    {e.fromStatus ? `${statusLabel(e.fromStatus)} → ` : ''}
                    <span className="font-medium">{statusLabel(e.toStatus)}</span>
                  </span>
                  <span className="shrink-0 text-[13px] text-muted-foreground">
                    {visitWhen(e.at, new Date())}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
