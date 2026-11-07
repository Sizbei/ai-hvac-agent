'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { FormFieldEditor } from '@/components/admin/forms/form-field-editor';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { LEAVE_UNSAVED_COPY, LEAVE_UNSAVED_TITLE } from '@/lib/admin/unsaved-changes';
import { mintKey } from '@/lib/http/idempotency-codes';
import { FORM_LIMITS } from '@/lib/forms/form-schema';
import { FORM_OFFICE_COPY } from '@/lib/admin/form-route-copy';
import {
  addField, builderErrors, firstSaveOutcome, fromDefinition, moveField, newBuilderForm, removeField, restoreField,
  sameDefinition, toDefinition, visibleErrors, type BuilderField, type BuilderForm,
} from '@/lib/admin/form-builder';
import type { FormRecord } from '@/lib/admin/form-queries';
import type { JobTypeRecord } from '@/lib/admin/job-type-types';

const SAVE_FAILED = "Couldn't save the form. Please try again.";
const SAVE_FIRST = 'Save or discard your changes first.';
const UNDO_MS = 5000;

const focusSoon = (id: string): void => {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
};

const REFUSAL_COPY: Record<string, string> = {
  NAME_TAKEN: FORM_OFFICE_COPY.NAME_TAKEN,
  LIMIT_REACHED: FORM_OFFICE_COPY.LIMIT_REACHED,
  UNKNOWN_JOB_TYPE: FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE,
  STALE: FORM_OFFICE_COPY.STALE,
};

async function call(url: string, init?: RequestInit): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

const errorCode = (body: unknown): string | null => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : null;
};

/** Office form builder (M3d spec §4.1, §7.1). `formId` null = New form (not inserted until the first valid Save). */
export function FormBuilderClient({ formId: initialId }: { readonly formId: string | null }) {
  const [formId, setFormId] = useState<string | null>(initialId);
  const [version, setVersion] = useState<number | null>(null);
  const [active, setActive] = useState(true);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [loaded, setLoaded] = useState<BuilderForm | null>(initialId === null ? newBuilderForm() : null);
  const [draft, setDraft] = useState<BuilderForm | null>(loaded);
  const [loadFailed, setLoadFailed] = useState(false);
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[] | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [headerMessage, setHeaderMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [undo, setUndo] = useState<{ field: BuilderField; at: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Minted once when the builder opens; every retry of the first Save reuses it.
  const clientToken = useRef<string>(mintKey());

  const applyRow = useCallback((row: { form: FormRecord; submissionCount: number }) => {
    const b = fromDefinition(row.form);
    setLoaded(b);
    setDraft(b);
    setVersion(row.form.version);
    setActive(row.form.active);
    setSubmissionCount(row.submissionCount);
    setTouched(new Set());
    setShowAll(false);
    setStale(false);
    setMessage(null);
    setHeaderMessage(null);
  }, []);

  const loadRow = useCallback(async (id: string): Promise<{ form: FormRecord; submissionCount: number } | null> => {
    const r = await call(`/api/admin/settings/forms/${id}`);
    const data = (r.body as { success?: boolean; data?: { form: FormRecord; submissionCount: number } } | null);
    return r.status === 200 && data?.success && data.data ? data.data : null;
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await call('/api/admin/settings/job-types');
      const data = r.body as { success?: boolean; data?: { jobTypes: JobTypeRecord[] } } | null;
      setJobTypes(r.status === 200 && data?.success && data.data ? data.data.jobTypes : []);
    })();
    if (initialId === null) return;
    void (async () => {
      const row = await loadRow(initialId);
      if (row) applyRow(row);
      else setLoadFailed(true);
    })();
  }, [initialId, loadRow, applyRow]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const errors = useMemo(() => (draft ? builderErrors(draft) : []), [draft]);
  // A New form compares against its own blank start, so an untouched one isn't "unsaved" (spec §7.1).
  const dirty = useMemo(
    () => draft !== null && loaded !== null && !sameDefinition(toDefinition(draft), toDefinition(loaded)),
    [draft, loaded],
  );
  const leaveGuard = useUnsavedChangesGuard(dirty);

  const edit = (target: string, next: BuilderForm) => {
    setDraft(next);
    setTouched((t) => (t.has(target) ? t : new Set([...t, target])));
    setMessage(null);
    setStale(false);
  };
  const editField = (index: number, next: BuilderField) => {
    if (!draft) return;
    edit(next.id, { ...draft, fields: draft.fields.map((f, i) => (i === index ? next : f)) });
  };

  async function save(): Promise<void> {
    if (!draft || saving) return;
    if (errors.length > 0 || !dirty) {
      setShowAll(true);
      return;
    }
    setSaving(true);
    setMessage(null);
    setStale(false);
    const def = toDefinition(draft);
    try {
      // A replay whose GET failed left the id without a version: read the row before PATCHing.
      let base = version;
      if (formId !== null && base === null) {
        const row = await loadRow(formId);
        if (!row) {
          setMessage(SAVE_FAILED);
          return;
        }
        base = row.form.version;
        setVersion(base);
        setLoaded(fromDefinition(row.form));
        setSubmissionCount(row.submissionCount);
      }
      if (formId === null) {
        const r = await call('/api/admin/settings/forms', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientToken: clientToken.current, ...def }),
        });
        const out = firstSaveOutcome(r.status, r.body);
        if (out.kind === 'created') {
          setFormId(out.id);
          setVersion(out.version);
          setLoaded(draft);
          // Native history keeps this component mounted (Next 16 integrates replaceState).
          window.history.replaceState(null, '', `/admin/settings/forms/${out.id}`);
        } else if (out.kind === 'replay') {
          const row = await loadRow(out.id);
          setFormId(out.id);
          window.history.replaceState(null, '', `/admin/settings/forms/${out.id}`);
          if (row) {
            setVersion(row.form.version);
            setLoaded(fromDefinition(row.form));
            setSubmissionCount(row.submissionCount);
          } else {
            setMessage(SAVE_FAILED);
          }
        } else if (out.kind === 'unknown') {
          setMessage(SAVE_FAILED);
        } else {
          setMessage(REFUSAL_COPY[out.code] ?? SAVE_FAILED);
        }
        return;
      }
      const r = await call(`/api/admin/settings/forms/${formId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: base, definition: def }),
      });
      const v = (r.body as { data?: { version?: number } } | null)?.data?.version;
      if (r.status === 200 && typeof v === 'number') {
        setVersion(v);
        setLoaded(draft);
        return;
      }
      const code = errorCode(r.body);
      if (code === 'STALE') setStale(true);
      setMessage((code && REFUSAL_COPY[code]) ?? SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(nextActive: boolean): Promise<void> {
    if (!formId) return;
    if (dirty) {
      setHeaderMessage(SAVE_FIRST);
      return;
    }
    setSaving(true);
    setStale(false);
    setHeaderMessage(null);
    // A replay whose GET failed left the id without a version: read the row first.
    let base = version;
    if (base === null) {
      const row = await loadRow(formId);
      if (!row) {
        setSaving(false);
        setArchiveOpen(false);
        setHeaderMessage(SAVE_FAILED);
        return;
      }
      base = row.form.version;
    }
    const r = await call(`/api/admin/settings/forms/${formId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: base, active: nextActive }),
    });
    setSaving(false);
    setArchiveOpen(false);
    const v = (r.body as { data?: { version?: number } } | null)?.data?.version;
    if (r.status === 200 && typeof v === 'number') {
      setVersion(v);
      setActive(nextActive);
      return;
    }
    const code = errorCode(r.body);
    if (code === 'STALE') setStale(true);
    setHeaderMessage((code && REFUSAL_COPY[code]) ?? SAVE_FAILED);
  }

  async function reload(): Promise<void> {
    if (!formId) return;
    const row = await loadRow(formId);
    if (row) applyRow(row);
  }

  // Moving a row remounts nothing but drops focus; put it back on the same button (or its twin at either end).
  function move(index: number, dir: -1 | 1): void {
    if (!draft) return;
    edit('form', { ...draft, fields: moveField(draft.fields, index, dir) });
    const id = draft.fields[index]!.id;
    const to = index + dir;
    const same = dir === -1 ? `move-up-${id}` : `move-down-${id}`;
    const other = dir === -1 ? `move-down-${id}` : `move-up-${id}`;
    const atEnd = dir === -1 ? to === 0 : to === draft.fields.length - 1;
    focusSoon(atEnd ? other : same);
  }

  function remove(index: number): void {
    if (!draft) return;
    const r = removeField(draft.fields, index);
    if (!r.removed) return;
    edit('form', { ...draft, fields: r.fields });
    setUndo(r.removed);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    focusSoon('undo-removed');
  }

  if (loadFailed) {
    return (
      <PageShell narrow>
        <PageHeader title="Form" back={{ href: '/admin/settings?tab=forms', label: 'Back to forms' }} />
        <p role="alert" className="text-sm text-destructive">Couldn&apos;t load this form.</p>
      </PageShell>
    );
  }
  if (!draft || jobTypes === null) {
    return (
      <PageShell narrow>
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </PageShell>
    );
  }

  const shown = visibleErrors(errors, touched, showAll);
  const formErrors = shown.filter((e) => e.target === 'form').map((e) => e.message);
  const longTextCount = draft.fields.filter((f) => f.type === 'long_text').length;
  const activeTypes = jobTypes.filter((j) => j.active);
  const archivedPicked = jobTypes.filter((j) => !j.active && draft.jobTypeIds.includes(j.id));
  const toggleJobType = (id: string, on: boolean) =>
    edit('form', { ...draft, jobTypeIds: on ? [...draft.jobTypeIds, id] : draft.jobTypeIds.filter((x) => x !== id) });

  return (
    <PageShell narrow>
      <PageHeader
        title={draft.name.trim() || 'New form'}
        back={{ href: '/admin/settings?tab=forms', label: 'Back to forms' }}
        actions={formId && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => (active ? (dirty ? setHeaderMessage(SAVE_FIRST) : setArchiveOpen(true)) : void setArchived(true))}>
            {active ? 'Archive' : 'Restore'}
          </Button>
        )}
      />

      {headerMessage && (
        <p role="alert" className="text-sm text-destructive">
          {headerMessage}{' '}
          {stale && <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>Reload</Button>}
        </p>
      )}

      <SectionCard title="Form">
        <div id="form-header" className="space-y-4 p-4">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Name</span>
            <Input value={draft.name} onChange={(e) => edit('form', { ...draft, name: e.target.value })} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Description</span>
            <Textarea rows={2} value={draft.description} onChange={(e) => edit('form', { ...draft, description: e.target.value })} />
          </label>
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">Applies to</legend>
            <label className="flex items-center gap-2">
              <input type="radio" className="size-4 accent-primary" name="applies" checked={draft.appliesTo === 'all'} onChange={() => edit('form', { ...draft, appliesTo: 'all' })} />
              All requests
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" className="size-4 accent-primary" name="applies" checked={draft.appliesTo === 'some'} onChange={() => edit('form', { ...draft, appliesTo: 'some' })} />
              Some job types
            </label>
            {draft.appliesTo === 'some' && (
              jobTypes.length === 0 ? (
                <p className="text-muted-foreground">No job types yet. Add them on the Job types tab.</p>
              ) : (
                <div className="grid gap-1 pl-6 sm:grid-cols-2">
                  {[...activeTypes, ...archivedPicked].map((j) => (
                    <label key={j.id} className="flex items-center gap-2">
                      <input type="checkbox" className="size-4 accent-primary" checked={draft.jobTypeIds.includes(j.id)} onChange={(e) => toggleJobType(j.id, e.target.checked)} />
                      {j.active ? j.name : `${j.name} (archived)`}
                    </label>
                  ))}
                </div>
              )
            )}
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={draft.required} onCheckedChange={(v) => edit('form', { ...draft, required: v })} aria-labelledby="required-form-label" aria-describedby="required-form-help" />
            <span>
              <span id="required-form-label">Required form</span>
              <span id="required-form-help" className="block text-xs text-muted-foreground">
                Technicians see this form as Required and are reminded before closing out. Nothing is blocked.
              </span>
            </span>
          </label>
          {formErrors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">{formErrors.map((m) => <li key={m}>{m}</li>)}</ul>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Questions" count={draft.fields.length}>
        <ol className="divide-y">
          {draft.fields.map((f, i) => (
            <FormFieldEditor
              key={f.id}
              field={f}
              index={i}
              count={draft.fields.length}
              longTextFull={longTextCount >= FORM_LIMITS.maxLongText}
              canAdd={draft.fields.length < FORM_LIMITS.maxFields}
              errors={shown.filter((e) => e.target === f.id).map((e) => e.message)}
              onChange={(next) => editField(i, next)}
              onMove={(dir) => move(i, dir)}
              onAddBelow={() => edit('form', { ...draft, fields: addField(draft.fields, i) })}
              onRemove={() => remove(i)}
            />
          ))}
        </ol>
        <div className="space-y-2 border-t p-4">
          {undo && (
            <p role="status" className="flex items-center gap-2 text-sm">
              Question removed.
              <Button id="undo-removed" type="button" size="sm" variant="ghost" onClick={() => { setDraft({ ...draft, fields: restoreField(draft.fields, undo) }); setUndo(null); }}>
                Undo
              </Button>
            </p>
          )}
          <Button type="button" variant="outline" size="sm" disabled={draft.fields.length >= FORM_LIMITS.maxFields} onClick={() => edit('form', { ...draft, fields: addField(draft.fields, draft.fields.length - 1) })}>
            <Plus className="size-4" /> Add question
          </Button>
          <p className="text-xs text-muted-foreground">Need a photo? Ask technicians to add it in the technician app&apos;s Photos card.</p>
        </div>
      </SectionCard>

      <div className="space-y-2">
        {submissionCount > 0 && <p className="text-sm text-muted-foreground">Forms already started keep the earlier version.</p>}
        {shown.length > 0 && (
          <div aria-live="polite" className="text-sm">
            <p className="font-medium">Fix these to save:</p>
            <ul className="list-disc pl-5">
              {shown.map((e) => (
                <li key={`${e.target}-${e.message}`}>
                  <a className="underline" href={e.target === 'form' ? '#form-header' : `#field-${e.target}`}>{e.message}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}{' '}
            {stale && <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>Reload</Button>}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* aria-disabled, not disabled: Save stays focusable and a press shows every reason (save() sets showAll). */}
          <Button type="button" disabled={saving} aria-disabled={errors.length > 0 || !dirty} className="aria-disabled:opacity-50" onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {formId && dirty && loaded && (
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setDraft(loaded); setTouched(new Set()); setShowAll(false); setMessage(null); setUndo(null); }}>
              Discard changes
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this form?"
        description="Technicians can't start it any more. Forms already started can still be finished, and answers are kept."
        confirmLabel="Archive"
        isConfirming={saving}
        onConfirm={() => void setArchived(false)}
      />
      <ConfirmDialog
        open={leaveGuard.pendingHref !== null}
        onOpenChange={(open) => { if (!open) leaveGuard.stay(); }}
        title={LEAVE_UNSAVED_TITLE}
        description={LEAVE_UNSAVED_COPY}
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        onConfirm={leaveGuard.leave}
      />
    </PageShell>
  );
}
