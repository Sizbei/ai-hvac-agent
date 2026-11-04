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
import { TechJobSummary } from '@/components/tech/tech-job-summary';
import { SignaturePad } from '@/components/tech/signature-pad';
import { mintKey } from '@/lib/http/idempotency-codes';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { outcomeEvent, type WriteOutcome } from '@/lib/tech/invoice-key-state';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';

interface Material {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly unitPriceCents: number;
}

interface PricebookItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly priceCents: number;
}

interface TimeEntry {
  readonly id: string;
  readonly technicianId: string;
  readonly clockInAt: string;
  readonly clockOutAt: string | null;
  readonly minutes: number | null;
  readonly laborCostCents: number | null;
}

interface TimelineEntry {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly at: string;
}

interface PhotoRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly url: string | null;
}

/** "no_cool" / "in_progress" → "No cool" / "In progress". */
function humanizeStatus(s: string): string {
  const spaced = s.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format whole minutes as "Hh Mm" (or "Mm" under an hour). */
function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

/** Copy for a signature write that did not land (spec §7.6). */
function signatureErrorCopy(outcome: WriteOutcome, message: string | undefined): string {
  if (outcome === 'retry_same_key_after_refetch') return "Couldn't save the signature. Try again.";
  if (outcome === 'wait_then_refetch') return 'Still saving your last tap. Try again in a moment.';
  return message ?? "Couldn't save the signature. Try again.";
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function TechJobDetailClient({
  id,
  appointmentId,
}: {
  readonly id: string;
  readonly appointmentId?: string;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // A load failure must NOT masquerade as an empty job (no materials / not
  // clocked in) — surface it so the tech doesn't re-add duplicates or assume
  // they're off the clock. Either the materials or timesheet fetch can set it.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Timesheet (labor tracking)
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [openSince, setOpenSince] = useState<string | null>(null);
  const [isClocking, setIsClocking] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  // Ticks every second so the elapsed time updates live while on the clock.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Material add form
  const [catalog, setCatalog] = useState<PricebookItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [manualDesc, setManualDesc] = useState('');
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

  // Job photos (field uploads).
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);

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

  const loadPhotos = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/photo`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setPhotos(body.data.photos);
      }
      // Non-critical: a failed list just leaves the gallery empty.
    } catch {
      /* non-critical */
    }
  }, [id]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const handlePhotoChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file
      if (!file) return;
      setIsUploadingPhoto(true);
      setPhotoStatus(null);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/tech/jobs/${id}/photo`, {
          method: 'POST',
          body: form,
        });
        if (res.ok) {
          setPhotoStatus('Photo uploaded.');
          await loadPhotos();
        } else {
          const body = await res.json().catch(() => ({}));
          setPhotoStatus(body?.error?.message ?? "Couldn't upload that photo.");
        }
      } catch {
        setPhotoStatus('Network error — the photo was not uploaded.');
      } finally {
        setIsUploadingPhoto(false);
      }
    },
    [id, loadPhotos],
  );

  const loadTimesheet = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/timesheet`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setEntries(body.data.entries);
        setOpenSince(body.data.open ? body.data.open.clockInAt : null);
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

  // Live-tick the elapsed clock only while on the clock.
  useEffect(() => {
    if (!openSince) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [openSince]);

  const handleClock = useCallback(
    async (action: 'clock_in' | 'clock_out'): Promise<void> => {
      setIsClocking(true);
      setClockError(null);
      try {
        const res = await fetch(`/api/tech/jobs/${id}/timesheet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const body = await res.json().catch(() => ({ success: false }));
        if (res.ok && body.success) {
          void loadTimesheet();
        } else {
          setClockError(body.error?.message ?? 'Failed to update timesheet');
        }
      } catch {
        setClockError('Could not connect to server.');
      } finally {
        setIsClocking(false);
      }
    },
    [id, loadTimesheet],
  );

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
    setIsAdding(true);
    setAddError(null);
    try {
      const payload = selectedItemId
        ? { pricebookItemId: selectedItemId, quantity: qty }
        : { description: manualDesc.trim(), quantity: qty };
      const res = await fetch(`/api/tech/jobs/${id}/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setSelectedItemId('');
        setManualDesc('');
        setQuantity('1');
        setSearch('');
        void loadMaterials();
      } else {
        setAddError(body.error?.message ?? 'Failed to add material');
      }
    } catch {
      setAddError('Could not connect to server.');
    } finally {
      setIsAdding(false);
    }
  }, [id, quantity, selectedItemId, manualDesc, loadMaterials]);

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
      let message: string | undefined;
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
        message = err?.error?.message;
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
      setSigError(signatureErrorCopy(outcome, message));
    },
    [id, sigDispatch, signedAt, loadSignedAt],
  );

  const filteredCatalog = search.trim()
    ? catalog.filter((c) =>
        c.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : catalog;

  // Live elapsed minutes while on the clock (whole minutes, floored).
  const elapsedMins = openSince
    ? Math.max(0, Math.floor((nowMs - new Date(openSince).getTime()) / 60000))
    : 0;
  const todaysEntries = entries.filter((e) => isToday(e.clockInAt));

  return (
    <div className="space-y-5">
      <Link
        href="/tech/jobs"
        className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link"
      >
        <ArrowLeft className="size-4" /> Back
      </Link>

      {/* All info the tech needs on-site + status controls. */}
      <TechJobSummary id={id} appointmentId={appointmentId} onStatusChanged={() => void loadTimeline()} />

      {loadError && (
        <div
          role="alert"
          className="rounded-md border border-danger-border bg-danger-light px-3 py-2 text-[15px] text-danger-strong"
        >
          {loadError} Some data may be missing — pull to refresh or reopen the job.
        </div>
      )}

      {/* Time on this job (clock in / out) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Time on this job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {openSince ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] text-muted-foreground">On the clock</p>
                <p className="font-mono text-[26px] leading-[30px] font-medium tabular-nums">
                  {formatMinutes(elapsedMins)}
                </p>
              </div>
              <Button
                variant="destructive"
                className="h-11 rounded-xl px-4 text-[15px]"
                disabled={isClocking}
                onClick={() => void handleClock('clock_out')}
              >
                {isClocking ? 'Saving…' : 'Clock Out'}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px] text-muted-foreground">Not clocked in.</p>
              <Button
                className="h-11 rounded-xl px-4 text-[15px]"
                disabled={isClocking}
                onClick={() => void handleClock('clock_in')}
              >
                {isClocking ? 'Saving…' : 'Clock In'}
              </Button>
            </div>
          )}
          {clockError && (
            <p className="text-[13px] text-danger-strong">{clockError}</p>
          )}

          {todaysEntries.length > 0 && (
            <ul className="space-y-1 border-t border-border pt-3">
              {todaysEntries.map((e) => (
                <li
                  key={e.id}
                  className="flex justify-between font-mono text-[13px] tabular-nums text-muted-foreground"
                >
                  <span>
                    {new Date(e.clockInAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    {' – '}
                    {e.clockOutAt
                      ? new Date(e.clockOutAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : 'now'}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {e.minutes !== null ? formatMinutes(e.minutes) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
                  <span>
                    {m.description ?? 'Material'}
                    {m.quantity > 1 ? ` × ${m.quantity}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[14px] tabular-nums text-foreground">
                      {formatCentsExact(m.unitPriceCents * m.quantity)}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove material"
                      onClick={() => void handleRemove(m.id)}
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-foreground-faint active:bg-danger-light active:text-danger-strong"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Add material */}
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
              <Input
                placeholder="Manual description"
                value={manualDesc}
                onChange={(e) => setManualDesc(e.target.value)}
                className="h-11 rounded-xl text-[15px] md:text-[15px]"
              />
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
        </CardContent>
      </Card>

      {/* On-site note */}
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

      {/* Customer signature */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Customer signature</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {signedAt === undefined ? (
            <Skeleton className="h-[140px] w-full rounded-xl" />
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
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Photos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="inline-flex">
            <span className="sr-only">Add a photo</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={isUploadingPhoto}
              onChange={(e) => void handlePhotoChange(e)}
              aria-label="Add a job photo"
              className="text-[15px] file:mr-3 file:h-11 file:rounded-xl file:border-0 file:bg-primary file:px-4 file:text-[15px] file:font-medium file:text-primary-foreground"
            />
          </label>
          {isUploadingPhoto && (
            <p className="text-[13px] text-muted-foreground">Uploading…</p>
          )}
          {photoStatus && (
            <p className="text-[13px] text-muted-foreground">{photoStatus}</p>
          )}
          {photos.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">No photos yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {photos.map((p) =>
                p.url ? (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.url}
                      alt={p.filename}
                      className="aspect-square w-full rounded-md border border-border object-cover"
                    />
                  </a>
                ) : (
                  <div
                    key={p.id}
                    className="flex aspect-square w-full items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground"
                  >
                    {p.filename}
                  </div>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>

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
                    {e.fromStatus ? `${humanizeStatus(e.fromStatus)} → ` : ''}
                    <span className="font-medium">{humanizeStatus(e.toStatus)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">
                    {new Date(e.at).toLocaleString()}
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
