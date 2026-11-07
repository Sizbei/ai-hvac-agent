'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { FormFieldInput } from '@/components/tech/forms/form-field-input';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent } from '@/lib/tech/invoice-key-state';
import { ESTIMATE_INTENTS_KEY } from '@/lib/tech/estimate-intents';
import { postJson } from '@/components/tech/invoice/post-json';
import { answerText, applyChanges, valuesTooLarge, type Changes, type FieldValue, type FormValues } from '@/lib/forms/form-values';
import { utf8Bytes, type FormField } from '@/lib/forms/form-schema';
import {
  afterLanded, buildChanges, carryForNewVersion, clearAllChanges, inputsFromValues, mergeIntoInputs, nextLastValid, parseInput,
  submitBlock, unparsedIds, type InputValue, type Inputs,
} from '@/lib/tech/form-fill-state';
import { KEEPALIVE_MAX_BYTES, nextSaveState, nextWakeAt, SAVE_IDLE, saveDue, submitStep, type SaveEvent, type SaveState } from '@/lib/tech/form-save-machine';
import {
  backHref, dayShort, FOREIGN_CHANGE, firstName, fillHref, missingRequiredLine, readOnlyCopy, statusLine, SUBMITTED_BY_OTHER, SUBMITTED_ON,
  type StatusPhase,
} from '@/lib/tech/form-copy';
import type { TechFormView } from '@/lib/tech/form-view';

interface DraftBody {
  readonly appointmentId: string;
  readonly formVersion: number;
  readonly baseRevision: number;
  readonly saveId: string;
  readonly changes: Changes;
}
interface SubmitIntent {
  readonly path: string;
  readonly payload: Omit<DraftBody, 'saveId'>;
  /** The base the changes were made against: STALE / FORM_CHANGED recovery merges `payload.changes` over the re-read row. */
  readonly base: FormValues;
}

const GONE = 'This form is no longer on this job.';
const FIX_NUMBERS = 'Fix the highlighted answers.';
const ANSWER_THIS = 'Answer this.';

const nonNull = (c: Changes): FormValues =>
  Object.fromEntries(Object.entries(c).filter((e): e is [string, FieldValue] => e[1] !== null));

type Load = { kind: 'loading' } | { kind: 'ok'; view: TechFormView } | { kind: 'gone' } | { kind: 'error' };

async function getView(jobId: string, formId: string, visitId: string): Promise<{ status: number | null; view: TechFormView | null; code: string | null }> {
  try {
    // A dead connection times out into the caller's back-off instead of holding a re-read open forever.
    const res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}?visit=${visitId}`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, view: res.ok && body?.success ? (body.data as TechFormView) : null, code: body?.error?.code ?? null };
  } catch {
    return { status: null, view: null, code: null };
  }
}

/** The fill page (M3d spec §7.3). Answers save to the server as the technician types; submit is keyed. */
export function FormFillClient({
  jobId, formId, visitId, from,
}: { readonly jobId: string; readonly formId: string; readonly visitId: string; readonly from: string | null }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [inputs, setInputsState] = useState<Inputs>({});
  const [phase, setPhase] = useState<StatusPhase>('blank');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedByOther, setSavedByOther] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState<readonly string[]>([]);
  const [highlights, setHighlights] = useState<Readonly<Record<string, string>>>({});
  const [topLine, setTopLine] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [save, setSave] = useState<SaveState>(SAVE_IDLE);
  // Render mirrors of the refs below (refs can't be read during render).
  const [dirty, setDirty] = useState(false);
  const [answered, setAnswered] = useState(false);

  // Refs hold the latest values for async callbacks (no stale closures).
  const viewRef = useRef<TechFormView | null>(null);
  const fieldsRef = useRef<readonly FormField[]>([]);
  const inputsRef = useRef<Inputs>({});
  const baseRef = useRef<FormValues>({});
  const touchedRef = useRef<Set<string>>(new Set());
  const lastValidRef = useRef<Record<string, number>>({});
  const revisionRef = useRef(0);
  const versionRef = useRef(1);
  const pendingRef = useRef<DraftBody | null>(null);
  const flightRef = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef<SaveState>(SAVE_IDLE);
  const bannerShown = useRef(false);
  /**
   * The recovery of a stored submit intent, claimed once per intent (M3c's keyed-ref pattern; StrictMode runs
   * effects twice). A live submit claims it too, so only an intent restored at mount is ever re-sent on its own.
   * `done` is the shared promise a second caller awaits instead of starting another send.
   */
  const recovery = useRef<{ key: string; done: Promise<void> } | null>(null);
  /** A scheduled re-read after a failed one (reconcile's back-off); autosave waits while it is set. */
  const rereadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A re-read in flight: one reconcile at a time; a call made meanwhile waits in `queuedRef` (latest code wins). */
  const rereadingRef = useRef(false);
  /** The queued reconcile: its code and every recovered submit's changes queued with it (folded in when it runs). */
  const queuedRef = useRef<{ code: string | null; changes: Changes } | null>(null);
  const mountedRef = useRef(true);
  const reconcileRef = useRef<((code: string | null, mineOverride?: Changes, baseOverride?: FormValues) => Promise<void>) | null>(null);

  const intentId = `form:submit:${formId}:${visitId}`;
  const { state: keyState, dispatch: keyDispatch } = useIdempotencyKey({
    intentId, requestId: jobId, persist: true, storageKey: ESTIMATE_INTENTS_KEY, rehydrate: true,
  });

  const dispatchSave = useCallback((e: SaveEvent) => {
    saveRef.current = nextSaveState(saveRef.current, e);
    setSave(saveRef.current);
  }, []);
  const setInputs = useCallback((next: Inputs) => {
    inputsRef.current = next;
    setInputsState(next);
  }, []);
  /** Call after touching touchedRef / pendingRef / baseRef. */
  const syncFlags = useCallback(() => {
    setDirty(touchedRef.current.size > 0 || pendingRef.current !== null);
    setAnswered(Object.keys(baseRef.current).length > 0 || touchedRef.current.size > 0);
  }, []);
  const fieldName = useCallback((id: string) => fieldsRef.current.find((f) => f.id === id), []);
  const notSavedLines = useCallback((ids: Iterable<string>) => {
    const out: string[] = [];
    for (const id of ids) {
      const f = fieldName(id);
      if (!f) continue;
      const p = parseInput(f, inputsRef.current[id]);
      const v = p.kind === 'value' ? p.value ?? undefined : lastValidRef.current[id];
      out.push(`Not saved: ${f.label} · ${answerText(f, v)}`);
    }
    return out;
  }, [fieldName]);

  const applyView = useCallback((v: TechFormView) => {
    viewRef.current = v;
    fieldsRef.current = v.form.fields;
    versionRef.current = v.form.version;
    const values = v.submission?.values ?? {};
    baseRef.current = values;
    revisionRef.current = v.submission?.revision ?? 0;
    touchedRef.current = new Set();
    lastValidRef.current = Object.fromEntries(Object.entries(values).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
    setInputs(inputsFromValues(v.form.fields, values));
    setSavedAt(v.submission && v.submission.values && Object.keys(v.submission.values).length > 0 ? v.submission.updatedAt : null);
    setSavedByOther(v.submission && !v.submission.updatedByMe ? firstName(v.submission.updatedByName) : null);
    setPhase(v.submission?.status === 'submitted' ? 'submitted' : v.writeBlockedReason ? 'blocked' : v.submission ? 'saved' : 'blank');
    setLoad({ kind: 'ok', view: v });
    syncFlags();
  }, [setInputs, syncFlags]);

  /** The re-read view; 'gone' (404 / archived, the page says so); null = no answer (network, 5xx). */
  const refetch = useCallback(async (): Promise<TechFormView | 'gone' | null> => {
    const r = await getView(jobId, formId, visitId);
    if (r.view) return r.view;
    if (r.status === 404 || r.code === 'FORM_ARCHIVED') {
      setLoad({ kind: 'gone' });
      return 'gone';
    }
    return null;
  }, [jobId, formId, visitId]);

  /** Make a recovered submit's changes live edits: untouched fields take the change as a touched input. */
  const foldIntoInputs = useCallback((changes: Changes) => {
    const fields = fieldsRef.current;
    const add = Object.keys(changes).filter((id) => !touchedRef.current.has(id) && fields.some((f) => f.id === id));
    if (add.length === 0) return;
    const fresh = inputsFromValues(fields, nonNull(Object.fromEntries(add.map((id) => [id, changes[id]!]))));
    const next: Record<string, InputValue> = { ...inputsRef.current };
    const valid: Record<string, number> = { ...lastValidRef.current };
    for (const id of add) {
      next[id] = fresh[id]!;
      const value = changes[id];
      if (typeof value === 'number') valid[id] = value;
      else delete valid[id];
    }
    lastValidRef.current = valid;
    touchedRef.current = new Set([...touchedRef.current, ...add]);
    setInputs(next);
    syncFlags();
  }, [setInputs, syncFlags]);

  /** STALE / FORM_CHANGED / a refusal during autosave or submit: re-read and merge or go read-only. */
  const reconcileOnce = useCallback(async (code: string | null, mineOverride?: Changes, baseOverride?: FormValues) => {
    const old = fieldsRef.current;
    const mine = mineOverride ?? buildChanges(old, inputsRef.current, touchedRef.current, lastValidRef.current);
    const base = baseOverride ?? baseRef.current;
    const v = await refetch();
    if (!mountedRef.current) return;
    if (v === 'gone') {
      setNotSaved(notSavedLines(Object.keys(mine)));
      dispatchSave({ type: 'stop', reason: 'blocked' });
      return;
    }
    if (v === null) {
      // The re-read itself failed (a network blip): back off and try again, never freeze the page.
      dispatchSave({ type: 'unknown', now: Date.now(), retryAfterMs: null });
      setPhase('retrying');
      // A recovered submit's changes become live edits (touched inputs) first, so the rescheduled re-read merges
      // from the live inputs: edits typed during the back-off survive, and the submit's answers still go out
      // (autosave or the next submit). A live submit's changes are already touched, so nothing is overwritten.
      if (mineOverride) foldIntoInputs(mineOverride);
      rereadRef.current = setTimeout(() => {
        rereadRef.current = null;
        if (mountedRef.current) void reconcileRef.current?.(code);
      }, Math.max(0, saveRef.current.waitUntil - Date.now()));
      return;
    }
    if (v.submission?.status === 'submitted') {
      const lines = notSavedLines(Object.keys(mine));
      applyView(v);
      setNotice(SUBMITTED_BY_OTHER(v.submission.submittedByName ?? 'Someone'));
      setNotSaved(lines);
      return;
    }
    if (v.writeBlockedReason) {
      const lines = notSavedLines(Object.keys(mine));
      applyView(v);
      setNotSaved(lines);
      dispatchSave({ type: 'stop', reason: 'blocked' });
      return;
    }
    let fields = old;
    let carriedBase = base;
    let carriedMine = mine;
    let dropped: readonly string[] = [];
    if (code === 'FORM_CHANGED' || v.form.version !== versionRef.current) {
      fields = v.form.fields;
      const carried = carryForNewVersion(fields, base, mine);
      carriedBase = carried.base;
      carriedMine = carried.mine;
      dropped = carried.dropped;
      setNotSaved(notSavedLines(carried.dropped));
      setNotice('The office changed this form. Check your answers.');
    }
    const theirs = v.submission?.values ?? {};
    // A recovered submit's changes aren't in the inputs yet: rebuild those inputs from them.
    const mineInputs = mineOverride ? inputsFromValues(fields, nonNull(carriedMine)) : inputsRef.current;
    // A live merge keeps every touched input (a half-typed number isn't in `mine`); a recovered submit has only its changes.
    const ids = new Set(fields.map((f) => f.id));
    // A field the new version can't take (carryForNewVersion's `dropped`) leaves the touched set: its input follows
    // the merged value and it is never sent (its old answer is listed under "Not saved").
    const droppedIds = new Set(dropped);
    const touched = mineOverride
      ? new Set(Object.keys(carriedMine))
      : new Set([...touchedRef.current, ...Object.keys(carriedMine)].filter((id) => ids.has(id) && !droppedIds.has(id)));
    const merged = mergeIntoInputs(fields, carriedBase, carriedMine, theirs, mineInputs, touched, lastValidRef.current);
    viewRef.current = v;
    fieldsRef.current = fields;
    versionRef.current = v.form.version;
    baseRef.current = theirs;
    revisionRef.current = v.submission?.revision ?? 0;
    touchedRef.current = touched;
    // Untouched numbers follow the merged value (a later half-typed edit never sends a stale last-valid).
    lastValidRef.current = merged.lastValid;
    setInputs(merged.inputs);
    setLoad({ kind: 'ok', view: v });
    if (merged.foreignChange && !bannerShown.current) {
      bannerShown.current = true;
      setNotice(FOREIGN_CHANGE);
    }
    syncFlags();
    dispatchSave({ type: 'resume' });
    dispatchSave({ type: 'edit', now: Date.now() });
  }, [applyView, dispatchSave, foldIntoInputs, notSavedLines, refetch, setInputs, syncFlags]);
  const reconcile = useCallback(async (code: string | null, mineOverride?: Changes, baseOverride?: FormValues) => {
    if (!mountedRef.current) return;
    if (rereadingRef.current) {
      // Queue, never drop: it runs after the current re-read, with any recovered changes folded into the inputs.
      queuedRef.current = { code, changes: { ...queuedRef.current?.changes, ...mineOverride } };
      return;
    }
    rereadingRef.current = true;
    if (rereadRef.current) {
      // This call supersedes a scheduled re-read.
      clearTimeout(rereadRef.current);
      rereadRef.current = null;
    }
    try {
      await reconcileOnce(code, mineOverride, baseOverride);
    } finally {
      rereadingRef.current = false;
    }
    const queued = queuedRef.current;
    queuedRef.current = null;
    if (queued && mountedRef.current) {
      foldIntoInputs(queued.changes);
      await reconcileRef.current?.(queued.code);
    }
  }, [foldIntoInputs, reconcileOnce]);
  useEffect(() => {
    reconcileRef.current = reconcile;
  }, [reconcile]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (rereadRef.current) clearTimeout(rereadRef.current);
      rereadRef.current = null;
    };
  }, []);

  const currentChanges = useCallback(
    () => buildChanges(fieldsRef.current, inputsRef.current, touchedRef.current, lastValidRef.current),
    [],
  );

  /** One PUT; resolves true only when it landed. */
  const sendDraft = useCallback(async (kind: 'send_new' | 'send_retry'): Promise<boolean> => {
    let body = kind === 'send_retry' ? pendingRef.current : null;
    if (!body) {
      const changes = currentChanges();
      if (Object.keys(changes).length === 0) {
        // Nothing left to send (a retry after a merge, say): settle the machine and the line.
        dispatchSave({ type: 'landed' });
        setPhase(savedAt ? 'saved' : 'blank');
        return true;
      }
      const applied = applyChanges(fieldsRef.current, baseRef.current, changes);
      if (applied.ok && valuesTooLarge(applied.values)) {
        dispatchSave({ type: 'stop', reason: 'too_large' });
        setPhase('too_large');
        return false;
      }
      body = { appointmentId: visitId, formVersion: versionRef.current, baseRevision: revisionRef.current, saveId: mintKey(), changes };
    }
    pendingRef.current = body;
    syncFlags();
    dispatchSave({ type: 'sent', now: Date.now() });
    setPhase('saving');
    const text = JSON.stringify(body);
    const flight = (async () => {
      let res: Response | null = null;
      try {
        res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}/draft`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: utf8Bytes(text) <= KEEPALIVE_MAX_BYTES,
        });
      } catch {
        res = null;
      }
      const env = res ? await res.json().catch(() => null) : null;
      const sent = body!;
      if (res && res.ok && env?.success) {
        revisionRef.current = Number(env.data.revision);
        const r = afterLanded(fieldsRef.current, baseRef.current, sent.changes, inputsRef.current, touchedRef.current);
        baseRef.current = r.base;
        touchedRef.current = r.touched;
        pendingRef.current = null;
        syncFlags();
        setSavedAt(String(env.data.savedAt));
        setSavedByOther(null);
        setPhase('saved');
        dispatchSave({ type: 'landed' });
        return true;
      }
      const status = res?.status ?? null;
      const code: string | null = env?.error?.code ?? null;
      if (status === null || status >= 500 || status === 429) {
        const ra = Number(res?.headers.get('Retry-After'));
        dispatchSave({ type: 'unknown', now: Date.now(), retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
        setPhase('retrying');
        return false;
      }
      if (status === 401) {
        dispatchSave({ type: 'stop', reason: 'signed_out' });
        setPhase('signed_out');
        setNotSaved(notSavedLines(touchedRef.current));
        return false;
      }
      if (status === 400) {
        const tooLarge = Array.isArray(env?.error?.details?.path) && env.error.details.path[0] === 'values';
        if (tooLarge) pendingRef.current = null;
        syncFlags();
        dispatchSave({ type: 'stop', reason: tooLarge ? 'too_large' : 'bad_request' });
        setPhase(tooLarge ? 'too_large' : 'bad_request');
        return false;
      }
      pendingRef.current = null;
      syncFlags();
      dispatchSave({ type: 'landed' });
      if (status === 404) setNotice(GONE);
      await reconcile(code);
      return false;
    })();
    flightRef.current = flight;
    const landed = await flight;
    flightRef.current = null;
    return landed;
  }, [currentChanges, dispatchSave, formId, jobId, notSavedLines, reconcile, savedAt, syncFlags, visitId]);

  // Autosave timer: wake at the machine's next due time.
  useEffect(() => {
    const wake = nextWakeAt(save, dirty);
    if (wake === null) return;
    const t = setTimeout(() => {
      if (rereadRef.current || rereadingRef.current) return;
      const action = saveDue(saveRef.current, Date.now(), touchedRef.current.size > 0 || pendingRef.current !== null);
      if (action) void sendDraft(action);
    }, Math.max(0, wake - Date.now()));
    return () => clearTimeout(t);
  }, [save, dirty, sendDraft]);

  // hidden / pagehide save at once (bypassing the 3 s floor, keeping one in flight).
  useEffect(() => {
    const flush = () => {
      if (touchedRef.current.size === 0 && pendingRef.current === null) return;
      dispatchSave({ type: 'flush' });
      const action = saveDue(saveRef.current, Date.now(), true);
      if (action) void sendDraft(action);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [dispatchSave, sendDraft]);

  const submitFlow = useCallback(async (intent: SubmitIntent | null) => {
    let stored = intent;
    if (!stored) {
      // A live submit claims the recovery slot: its own unknown result waits for Try again, never an auto re-send.
      recovery.current ??= { key: intentId, done: Promise.resolve() };
      const payload = { appointmentId: visitId, formVersion: versionRef.current, baseRevision: revisionRef.current, changes: currentChanges() };
      stored = { path: `/api/tech/jobs/${jobId}/forms/${formId}/submit`, payload, base: baseRef.current };
      const hash = JSON.stringify(stored.payload);
      keyDispatch({ type: 'open', bodyHash: hash, body: stored, mint: mintKey });
      const pre = keyDispatch({ type: 'edit', bodyHash: hash, body: stored, mint: mintKey });
      if (pre.phase !== 'armed' && pre.phase !== 'unknown') return;
    }
    const s = keyDispatch({ type: 'sent' });
    if (s.phase !== 'sent') return;
    const sent = s.body as SubmitIntent;
    dispatchSave({ type: 'lock' });
    setPhase('submit_sent');
    const res = await postJson(sent.path, sent.payload, s.key);
    const env = res.status === null ? null : res.envelope;
    const code = env?.error?.code ?? null;
    const outcome = classifyWriteError(res.status, code, env?.error?.details);
    if (outcome === 'retry_same_key_after_refetch' || outcome === 'wait_then_refetch') {
      keyDispatch({ type: 'unknown' });
      setPhase('submit_unknown');
      return;
    }
    const ev = outcomeEvent(outcome, false);
    if (ev) keyDispatch({ type: ev });
    dispatchSave({ type: 'unlock' });
    if (outcome === 'success_refetch' || code === 'FORM_SUBMITTED') {
      // A submitted page never autosaves: a draft still queued behind the submit is dropped, not retried.
      pendingRef.current = null;
      // Nothing re-reads a submitted page: a scheduled or queued re-read would report the user's own submit as someone else's.
      if (rereadRef.current) clearTimeout(rereadRef.current);
      rereadRef.current = null;
      queuedRef.current = null;
      dispatchSave({ type: 'submitted' });
      setPhase('submitted');
      const v = await refetch();
      if (v && v !== 'gone') applyView(v);
      return;
    }
    if (code === 'FORM_INCOMPLETE') {
      const ids = (env?.error?.details as { fieldIds?: string[] } | undefined)?.fieldIds ?? [];
      setHighlights(Object.fromEntries(ids.map((id) => [id, ANSWER_THIS])));
      setTopLine(missingRequiredLine(ids.length));
      setPhase('saved');
      return;
    }
    // STALE / FORM_CHANGED: merge (or carry), unlock, show the line; a new tap and confirm send a new body (a new key).
    await reconcile(code, sent.payload.changes, sent.base);
  }, [applyView, currentChanges, dispatchSave, formId, intentId, jobId, keyDispatch, reconcile, refetch, visitId]);

  // Load, then recover a pending submit of this form on this visit (the page's own intent).
  useEffect(() => {
    void (async () => {
      const r = await getView(jobId, formId, visitId);
      if (r.view) applyView(r.view);
      else setLoad(r.status === 404 || r.code === 'FORM_ARCHIVED' ? { kind: 'gone' } : { kind: 'error' });
    })();
  }, [jobId, formId, visitId, applyView]);
  // The mount recovery of this page's own stored submit intent (the `recovery` ref above).
  useEffect(() => {
    if (load.kind !== 'ok' || keyState.phase !== 'unknown') return;
    if (recovery.current?.key === intentId) return;
    recovery.current = { key: intentId, done: submitFlow(keyState.body as SubmitIntent) };
  }, [load.kind, keyState, submitFlow, intentId]);

  const change = useCallback((field: FormField, v: InputValue): void => {
    setNotice((n) => (n === FOREIGN_CHANGE ? n : null));
    setHighlights((h) => {
      if (!(field.id in h)) return h;
      const rest = { ...h };
      delete rest[field.id];
      return rest;
    });
    lastValidRef.current = nextLastValid(lastValidRef.current, field, v);
    touchedRef.current = new Set([...touchedRef.current, field.id]);
    setInputs({ ...inputsRef.current, [field.id]: v });
    syncFlags();
    dispatchSave({ type: 'edit', now: Date.now() });
  }, [dispatchSave, setInputs, syncFlags]);

  async function onSubmitTap(): Promise<void> {
    const block = submitBlock(fieldsRef.current, inputsRef.current);
    if (block?.kind === 'unparsed') {
      setHighlights(Object.fromEntries(block.fieldIds.map((id) => [id, FIX_NUMBERS])));
      setTopLine(FIX_NUMBERS);
      document.getElementById(`q-${block.fieldIds[0]}`)?.querySelector('input')?.focus();
      return;
    }
    if (block?.kind === 'missing') {
      setHighlights(Object.fromEntries(block.fieldIds.map((id) => [id, ANSWER_THIS])));
      setTopLine(missingRequiredLine(block.fieldIds.length));
      return;
    }
    setTopLine(null);
    setConfirmOpen(true);
  }

  /**
   * Submit (spec §7.3): cancel the debounce, wait for the write in flight, re-send
   * a pending unknown draft with its own body and saveId and see it land, then
   * send the submit with the latest revision. A draft that doesn't land unlocks
   * the page instead: the technician sees the save line and taps Submit again.
   */
  async function confirmSubmit(): Promise<void> {
    setConfirmOpen(false);
    dispatchSave({ type: 'lock' });
    for (let round = 0; round < 3; round++) {
      const step = submitStep(saveRef.current, pendingRef.current !== null, flightRef.current !== null);
      if (step === 'send_submit') {
        await submitFlow(null);
        return;
      }
      if (step === 'await_flight') {
        await flightRef.current;
        continue;
      }
      if (!(await sendDraft('send_retry'))) break;
    }
    dispatchSave({ type: 'unlock' });
  }

  function clearAnswers(): void {
    setClearOpen(false);
    const changes = clearAllChanges(baseRef.current);
    touchedRef.current = new Set([...touchedRef.current, ...Object.keys(changes)]);
    lastValidRef.current = {};
    setInputs(inputsFromValues(fieldsRef.current, {}));
    syncFlags();
    dispatchSave({ type: 'flush' });
  }

  if (load.kind === 'loading') return <Skeleton className="h-64 w-full rounded-xl" />;
  if (load.kind === 'gone' || load.kind === 'error') {
    return (
      <Card>
        <CardContent className="space-y-4 py-6">
          <p role="alert" className="text-[17px] font-medium">{load.kind === 'gone' ? GONE : "Couldn't load this form."}</p>
          <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
            <ArrowLeft className="size-4" /> Back to job
          </Link>
        </CardContent>
      </Card>
    );
  }

  const v = load.view;
  const submitted = v.submission?.status === 'submitted' || phase === 'submitted';
  const locked = keyState.phase === 'sent' || keyState.phase === 'unknown';
  const writable = v.canWrite && !submitted && !locked && from === null && save.stop !== 'blocked' && save.stop !== 'signed_out' && save.stop !== 'submitted';
  const back = backHref({ jobId, formId, visitId, myVisit: v.myVisit, from });
  const unparsed = unparsedIds(v.form.fields, inputs).length;
  const line = statusLine({
    phase: locked ? (keyState.phase === 'sent' ? 'submit_sent' : 'submit_unknown') : submitted ? 'submitted' : phase,
    savedAt, savedByOther, unparsedCount: submitted ? 0 : unparsed,
    submittedAt: v.submission?.submittedAt ?? null, submittedByName: v.submission?.submittedByName ?? null, now: new Date(),
  });
  const reasons = readOnlyCopy(v.writeBlockedReason, { myRowCancelled: v.myRowCancelled });

  return (
    <div className="space-y-4 pb-28">
      <Link href={back.href} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
        <ArrowLeft className="size-4" /> {back.label}
      </Link>
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold">{v.form.name}</h1>
        {v.form.description && <p className="text-[15px] text-muted-foreground">{v.form.description}</p>}
        {line && <p className="text-[13px] text-muted-foreground">{line}</p>}
      </header>

      {v.submittedOn && !submitted && from === null && (
        <p className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">
          {SUBMITTED_ON(v.submittedOn.appointmentNumber, dayShort(v.submittedOn.submittedAt))}{' '}
          <Link className="text-link underline" href={fillHref(jobId, formId, v.submittedOn.appointmentId, visitId)}>
            View visit #{v.submittedOn.appointmentNumber}&apos;s answers
          </Link>
        </p>
      )}
      {reasons.map((r) => (
        <p key={r} role="status" className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">{r}</p>
      ))}
      {notice && <p role="status" className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">{notice}</p>}
      {phase === 'signed_out' && (
        <Link href="/tech-login" className="inline-flex h-11 items-center rounded-xl border px-4 text-[15px]">Sign in</Link>
      )}
      {notSaved.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground">{notSaved.map((l) => <li key={l}>{l}</li>)}</ul>
      )}
      {topLine && <p role="alert" className="text-[15px] text-danger-strong">{topLine}</p>}

      <Card>
        <CardContent className="space-y-4 py-4">
          {v.form.fields.map((f) => (
            <div key={f.id} id={`q-${f.id}`}>
              <FormFieldInput
                field={f}
                value={inputs[f.id]}
                readOnly={!writable}
                highlight={highlights[f.id] ?? null}
                onChange={(x) => change(f, x)}
                onBlur={() => {
                  setTyping(false);
                  dispatchSave({ type: 'flush' });
                }}
                onFocusInput={() => setTyping(true)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {writable && answered && (
        <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" onClick={() => setClearOpen(true)}>Clear answers</Button>
      )}

      <footer className={`${typing ? '' : 'sticky bottom-0'} space-y-2 border-t bg-background py-3`}>
        <p aria-live="polite" className="text-[13px] text-muted-foreground">{line === 'Saving…' ? '' : line}</p>
        {phase === 'bad_request' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => dispatchSave({ type: 'try_again' })}>Try again</Button>
        )}
        {keyState.phase === 'unknown' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => void submitFlow(keyState.body as SubmitIntent)}>Try again</Button>
        )}
        {submitted ? (
          <Link href={back.href} className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary text-[16px] text-primary-foreground">
            {back.label}
          </Link>
        ) : writable ? (
          <Button className="h-12 w-full rounded-xl text-[16px]" onClick={() => void onSubmitTap()}>Submit form</Button>
        ) : null}
      </footer>

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Submit “{v.form.name}”?</SheetTitle>
            <SheetDescription className="text-[15px]">After this, only the office can reopen it.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4">
            <Button className="h-12 rounded-xl text-[16px]" onClick={() => void confirmSubmit()}>Submit</Button>
            <Button variant="outline" className="h-12 rounded-xl text-[16px]" onClick={() => setConfirmOpen(false)}>Go back</Button>
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={clearOpen} onOpenChange={setClearOpen}>
        <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Clear all answers on this form?</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4">
            <Button className="h-12 rounded-xl text-[16px]" onClick={clearAnswers}>Clear answers</Button>
            <Button variant="outline" className="h-12 rounded-xl text-[16px]" onClick={() => setClearOpen(false)}>Go back</Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
