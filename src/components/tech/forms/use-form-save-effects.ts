'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { sleep } from '@/components/tech/forms/form-fill-io';
import { nextWakeAt, saveDue, settleStep, type SaveEvent, type SaveState } from '@/lib/tech/form-save-machine';

/** How long an in-app leave waits for the save to settle before staying put. */
const SETTLE_MS = 20_000;
/** Sends an in-app leave makes before giving up (a STALE merge needs a second). */
const SETTLE_SENDS = 4;

export interface SaveRefs {
  readonly saveRef: RefObject<SaveState>;
  readonly touchedRef: RefObject<Set<string>>;
  readonly pendingRef: RefObject<unknown>;
  readonly flightRef: RefObject<Promise<boolean> | null>;
  /** A scheduled re-read (reconcile's back-off). */
  readonly rereadRef: RefObject<ReturnType<typeof setTimeout> | null>;
  /** A re-read in flight. */
  readonly rereadingRef: RefObject<boolean>;
  readonly mountedRef: RefObject<boolean>;
}

/**
 * The fill page's save timing (M3d spec §7.3) and leaving (ruling R1): the
 * autosave timer, the hidden / pagehide leave save, the leave save on an
 * in-app unmount, and `leaveTo`, which waits for the save to settle (a STALE
 * merge and its re-save included) before navigating, showing "Saving…".
 */
export function useFormSaveEffects(o: SaveRefs & {
  readonly save: SaveState;
  readonly dirty: boolean;
  readonly dispatchSave: (e: SaveEvent) => void;
  readonly sendDraft: (kind: 'send_new' | 'send_retry', leave?: boolean) => Promise<boolean>;
  readonly reconcile: (code: string | null) => Promise<void>;
  /** Something would still change the row. */
  readonly unsaved: () => boolean;
}): { readonly leaving: boolean; readonly leaveTo: (href: string) => (e: MouseEvent<HTMLAnchorElement>) => void } {
  const { saveRef, touchedRef, pendingRef, flightRef, rereadRef, rereadingRef, mountedRef, save, dirty, dispatchSave, sendDraft, reconcile, unsaved } = o;
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const sendDraftRef = useRef(sendDraft);
  useEffect(() => {
    sendDraftRef.current = sendDraft;
  }, [sendDraft]);

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
  }, [save, dirty, sendDraft, saveRef, touchedRef, pendingRef, rereadRef, rereadingRef]);

  // hidden / pagehide save at once (bypassing the 3 s floor, keeping one in flight), as a leave save (R1b).
  useEffect(() => {
    const flush = () => {
      if (touchedRef.current.size === 0 && pendingRef.current === null) return;
      dispatchSave({ type: 'flush' });
      const action = saveDue(saveRef.current, Date.now(), true);
      if (action) void sendDraft(action, true);
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
  }, [dispatchSave, sendDraft, saveRef, touchedRef, pendingRef]);

  // Left in-app another way (the browser's Back): what's left goes as a leave save, after the write in flight.
  useEffect(() => () => {
    void (flightRef.current ?? Promise.resolve()).then(() => {
      const step = settleStep(saveRef.current, { pending: pendingRef.current !== null, dirty: unsaved(), flight: false, rereading: false });
      if (step === 'send_new' || step === 'send_retry') void sendDraftRef.current(step, true);
    });
  }, [flightRef, saveRef, pendingRef, unsaved]);

  /** Wait for the write in flight and any re-read, then send what's left until nothing is. False = stay. */
  const settle = useCallback(async (): Promise<boolean> => {
    const until = Date.now() + SETTLE_MS;
    let sends = 0;
    let reread = false;
    while (Date.now() < until && mountedRef.current) {
      if (rereadRef.current && !rereadingRef.current) {
        // A re-read is backing off after a failure: run it now, once.
        if (reread) return false;
        reread = true;
        await reconcile(null);
        continue;
      }
      const step = settleStep(saveRef.current, {
        pending: pendingRef.current !== null, dirty: unsaved(), flight: flightRef.current !== null, rereading: rereadingRef.current,
      });
      if (step === 'done') return true;
      if (step === 'fail') return false;
      if (step === 'wait') {
        await (flightRef.current ?? sleep(100));
        continue;
      }
      if (sends++ >= SETTLE_SENDS) return false;
      if (!(await sendDraft(step)) && saveRef.current.retryPending) return false;
    }
    return false;
  }, [reconcile, sendDraft, unsaved, mountedRef, rereadRef, rereadingRef, saveRef, pendingRef, flightRef]);

  const leaveTo = useCallback((href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    void settle().then((ok) => {
      if (ok) {
        router.push(href);
        return;
      }
      leavingRef.current = false;
      setLeaving(false);
    });
  }, [router, settle]);

  return { leaving, leaveTo };
}
