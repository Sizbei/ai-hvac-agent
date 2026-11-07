'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { FormFillView, GONE, type FillLoad } from '@/components/tech/forms/form-fill-view';
import { clearLeaveMark, getView, leaveMarkKey, readLeaveMark, sleep, writeLeaveMark } from '@/components/tech/forms/form-fill-io';
import { useFormSaveEffects } from '@/components/tech/forms/use-form-save-effects';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent } from '@/lib/tech/invoice-key-state';
import { ESTIMATE_INTENTS_KEY } from '@/lib/tech/estimate-intents';
import { postJson } from '@/components/tech/invoice/post-json';
import { answerText, applyChanges, valuesTooLarge, type Changes, type FormValues } from '@/lib/forms/form-values';
import { utf8Bytes, type FormField } from '@/lib/forms/form-schema';
import {
  afterLanded, buildChanges, clearAllChanges, inputsFromValues, leaveBases, leaveMarkPending, leaveOutcome, nextLastValid,
  nonNull, parseInput, reconcileTransition, submitBlock, unsavedChanges, type InputValue, type Inputs,
} from '@/lib/tech/form-fill-state';
import { KEEPALIVE_MAX_BYTES, nextSaveState, SAVE_IDLE, submitStep, type SaveEvent, type SaveState } from '@/lib/tech/form-save-machine';
import { FOREIGN_CHANGE, firstName, missingRequiredLine, SUBMITTED_BY_OTHER, type StatusPhase } from '@/lib/tech/form-copy';
import type { TechFormView } from '@/lib/tech/form-view';

interface DraftBody {
  readonly appointmentId: string;
  readonly formVersion: number;
  readonly baseRevision: number;
  readonly saveId: string;
  readonly changes: Changes;
  /** A leave save (R1b) keeps its flag and the bases it was built on through retries (re-review M-2). */
  readonly leave?: true;
  readonly bases?: Changes;
}
interface SubmitIntent {
  readonly path: string;
  readonly payload: Omit<DraftBody, 'saveId' | 'leave' | 'bases'>;
  /** The base the changes were made against: STALE / FORM_CHANGED recovery merges `payload.changes` over the re-read row. */
  readonly base: FormValues;
}

const FIX_NUMBERS = 'Fix the highlighted answers.';
const ANSWER_THIS = 'Answer this.';
/** A draft PUT that hasn't answered by then is treated as unknown (re-sent with its saveId). */
const DRAFT_TIMEOUT_MS = 15_000;

type Load = { kind: 'loading' } | FillLoad;

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
  const markKey = leaveMarkKey(formId, visitId);
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

  /** `showSaved` false: a leave-time save may not have landed yet, so the line doesn't say "Saved" over this read (R1). */
  const applyView = useCallback((v: TechFormView, showSaved = true) => {
    viewRef.current = v;
    fieldsRef.current = v.form.fields;
    versionRef.current = v.form.version;
    const values = v.submission?.values ?? {};
    baseRef.current = values;
    revisionRef.current = v.submission?.revision ?? 0;
    touchedRef.current = new Set();
    lastValidRef.current = Object.fromEntries(Object.entries(values).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
    setInputs(inputsFromValues(v.form.fields, values));
    setSavedAt(showSaved && v.submission && v.submission.values && Object.keys(v.submission.values).length > 0 ? v.submission.updatedAt : null);
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
    const mine = mineOverride ?? buildChanges(fieldsRef.current, inputsRef.current, touchedRef.current, lastValidRef.current);
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
    if (v.submission?.status === 'submitted' || v.writeBlockedReason) {
      const lines = notSavedLines(Object.keys(mine));
      applyView(v);
      if (v.submission?.status === 'submitted') setNotice(SUBMITTED_BY_OTHER(v.submission.submittedByName ?? 'Someone'));
      else dispatchSave({ type: 'stop', reason: 'blocked' });
      setNotSaved(lines);
      return;
    }
    const r = reconcileTransition(
      { fields: fieldsRef.current, version: versionRef.current, base, inputs: inputsRef.current, touched: touchedRef.current, lastValid: lastValidRef.current },
      mine, mineOverride !== undefined, v, code,
    );
    if (r.formChanged) {
      // Before the fields change: the dropped answers are named from the old version.
      setNotSaved(notSavedLines(r.dropped));
      setNotice('The office changed this form. Check your answers.');
    }
    viewRef.current = v;
    fieldsRef.current = r.fields;
    versionRef.current = r.version;
    baseRef.current = r.base;
    revisionRef.current = r.revision;
    touchedRef.current = r.touched;
    lastValidRef.current = r.lastValid;
    setInputs(r.inputs);
    setLoad({ kind: 'ok', view: v });
    if (r.foreignChange && !bannerShown.current) {
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

  const currentChanges = useCallback(
    () => buildChanges(fieldsRef.current, inputsRef.current, touchedRef.current, lastValidRef.current),
    [],
  );
  /** Something here would still change the row (a landed "12." with its 12 saved doesn't count). */
  const unsaved = useCallback(
    () => pendingRef.current !== null || Object.keys(unsavedChanges(currentChanges(), baseRef.current)).length > 0,
    [currentChanges],
  );

  /**
   * One PUT; resolves true only when it landed. `leave` (hidden / pagehide / unmount, ruling R1b) adds
   * `leave: true` and each changed field's last-seen base, so a newer row merges field-wise instead of STALE.
   */
  const sendDraft = useCallback(async (kind: 'send_new' | 'send_retry', leave = false): Promise<boolean> => {
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
    // A leave save stays one on retry, with the bases it was first built on (the pending body hasn't landed, so
    // `baseRef` hasn't moved; an upgraded retry computes them now from the same base).
    if (leave && !body.leave) body = { ...body, leave: true, bases: leaveBases(body.changes, baseRef.current) };
    const isLeave = body.leave === true;
    pendingRef.current = body;
    syncFlags();
    dispatchSave({ type: 'sent', now: Date.now() });
    setPhase('saving');
    if (isLeave) writeLeaveMark(markKey, body.changes);
    const text = JSON.stringify(body);
    const flight = (async () => {
      let res: Response | null = null;
      try {
        // A stalled connection times out into the back-off (same body and saveId: a replay if it landed). The leave
        // save sent as the page goes stays fire-and-forget: no timeout on it.
        res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}/draft`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: utf8Bytes(text) <= KEEPALIVE_MAX_BYTES,
          ...(leave ? {} : { signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS) }),
        });
      } catch {
        res = null;
      }
      const env = res ? await res.json().catch(() => null) : null;
      const sent = body!;
      if (res && res.ok && env?.success) {
        const revision = Number(env.data.revision);
        // A leave save may skip fields a colleague changed: only what it applied counts as landed.
        const out = isLeave ? leaveOutcome(sent.changes, sent.baseRevision, revision, env.data.skipped) : { merged: false, applied: sent.changes };
        // A merged answer's revision holds a colleague's changes this page hasn't read: keep the old revision, so
        // any save before the re-read below is STALE (or merges field-wise) instead of overwriting them (M-1).
        if (!out.merged) revisionRef.current = revision;
        const r = afterLanded(fieldsRef.current, baseRef.current, out.applied, inputsRef.current, touchedRef.current);
        baseRef.current = r.base;
        touchedRef.current = r.touched;
        pendingRef.current = null;
        if (isLeave) clearLeaveMark(markKey);
        syncFlags();
        setSavedAt(env.data.savedAt ? String(env.data.savedAt) : new Date().toISOString());
        setSavedByOther(null);
        // After `Clear answers` lands nothing is answered: the line goes blank, like the card's "Not started".
        setPhase(Object.keys(r.base).length === 0 ? 'blank' : 'saved');
        dispatchSave({ type: 'landed' });
        // Merged over a newer row while this page stayed open (hidden, then back): re-read it.
        if (out.merged) await reconcile(null);
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
  }, [currentChanges, dispatchSave, formId, jobId, markKey, notSavedLines, reconcile, savedAt, syncFlags, visitId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (rereadRef.current) clearTimeout(rereadRef.current);
      rereadRef.current = null;
    };
  }, []);
  const { leaving, leaveTo } = useFormSaveEffects({
    saveRef, touchedRef, pendingRef, flightRef, rereadRef, rereadingRef, mountedRef, save, dirty, dispatchSave, sendDraft, reconcile, unsaved,
  });

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

  // Load (once per mount: StrictMode's first run is discarded, so its late answer can't reset early edits).
  useEffect(() => {
    let live = true;
    const quiet = () => !live || touchedRef.current.size > 0 || pendingRef.current !== null || saveRef.current.locked;
    void (async () => {
      const r = await getView(jobId, formId, visitId);
      if (!live) return;
      if (!r.view) {
        setLoad(r.status === 404 || r.code === 'FORM_ARCHIVED' ? { kind: 'gone' } : { kind: 'error' });
        return;
      }
      const waiting = leaveMarkPending(readLeaveMark(markKey), Date.now(), r.view.submission?.values ?? {});
      applyView(r.view, !waiting);
      // R1: the last page's leave-time save (a reload within the debounce) may land after this read. Read again,
      // briefly, before saying "Saved"; an edit here stops it (its save merges with that row anyway).
      for (let i = 0; waiting && i < 4; i++) {
        await sleep(750);
        if (quiet()) break;
        const again = await getView(jobId, formId, visitId);
        if (quiet()) break;
        if (again.view && !leaveMarkPending(readLeaveMark(markKey), Date.now(), again.view.submission?.values ?? {})) {
          applyView(again.view);
          break;
        }
      }
      if (live) clearLeaveMark(markKey);
    })();
    return () => {
      live = false;
    };
  }, [jobId, formId, visitId, applyView, markKey]);
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
  return (
    <FormFillView
      load={load} jobId={jobId} formId={formId} visitId={visitId} from={from} inputs={inputs} phase={phase} savedAt={savedAt}
      savedByOther={savedByOther} notice={notice} notSaved={notSaved} highlights={highlights} topLine={topLine} typing={typing}
      stop={save.stop} keyPhase={keyState.phase} leaving={leaving} answered={answered} leaveTo={leaveTo}
      onChange={change} onBlurInput={() => { setTyping(false); dispatchSave({ type: 'flush' }); }} onFocusInput={() => setTyping(true)}
      onTryAgainDraft={() => dispatchSave({ type: 'try_again' })} onTryAgainSubmit={() => { if (keyState.phase === 'unknown') void submitFlow(keyState.body as SubmitIntent); }}
      onSubmitTap={() => void onSubmitTap()} confirmOpen={confirmOpen} setConfirmOpen={setConfirmOpen} onConfirmSubmit={() => void confirmSubmit()}
      clearOpen={clearOpen} setClearOpen={setClearOpen} onClear={clearAnswers}
    />
  );
}
