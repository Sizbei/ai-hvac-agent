'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE, nextKeyState, type KeyEvent, type KeyState } from '@/lib/tech/invoice-key-state';
import { INTENTS_STORAGE_KEY, parseIntents, persistOps, serializeIntents } from '@/lib/tech/invoice-intent-persist';

/** Read-modify-write one request's intent map. Storage can throw (private
 * mode, quota); persistence is then best effort and the in-memory state rules. */
function applyPersist(storageKey: string, intentId: string, op: 'write' | 'clear', next: KeyState): void {
  try {
    const rest = Object.fromEntries(
      Object.entries(parseIntents(window.sessionStorage.getItem(storageKey))).filter(([id]) => id !== intentId),
    );
    const map = op === 'write' ? { ...rest, [intentId]: next } : rest;
    if (Object.keys(map).length === 0) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, serializeIntents(map));
  } catch {
    /* storage unavailable: keep going in memory */
  }
}

/**
 * One idempotency intent (M3b spec §7.5). `dispatch` runs `nextKeyState`
 * synchronously against the latest state, persists the transition BEFORE it
 * returns (so `dispatch({ type: 'sent' })` is on disk before the caller's
 * fetch), and returns the new state so the caller can read the key at once.
 * `persist: false` for the signature intent (its body is a Blob).
 * `storageKey` (default: the invoice key) lets M3c keep estimate and equipment
 * intents apart; `rehydrate: false` leaves stored intents to the caller's own
 * recovery (M3c surfaces re-send them before unlocking).
 *
 * Send rule: callers gate on the EDIT dispatch's phase. Dispatch
 * `edit(currentBody)` first and proceed only when the result is `armed` (first
 * send) or `unknown` (re-send of the old body); a `sent` result means a request
 * is already in flight (`sent + sent` is a no-op), so the tap must not POST.
 */
export function useIdempotencyKey(opts: {
  intentId: string;
  requestId: string;
  persist: boolean;
  storageKey?: (requestId: string) => string;
  rehydrate?: boolean;
}): { state: KeyState; dispatch(e: KeyEvent): KeyState } {
  const { intentId, requestId, persist } = opts;
  const keyFor = opts.storageKey ?? INTENTS_STORAGE_KEY;
  const rehydrate = opts.rehydrate ?? true;
  const [state, setState] = useState<KeyState>(IDLE);
  const stateRef = useRef<KeyState>(IDLE);

  // Rehydrate an in-flight intent after a reload (a persisted `sent` comes back
  // as `unknown`). Runs after mount: sessionStorage does not exist on the server.
  useEffect(() => {
    if (!persist || !rehydrate) return;
    let restored: KeyState | undefined;
    try {
      restored = parseIntents(window.sessionStorage.getItem(keyFor(requestId)))[intentId];
    } catch {
      restored = undefined;
    }
    if (restored && stateRef.current.phase === 'idle') {
      stateRef.current = restored;
      setState(restored);
    }
  }, [persist, rehydrate, keyFor, requestId, intentId]);

  const dispatch = useCallback(
    (e: KeyEvent): KeyState => {
      const prev = stateRef.current;
      const next = nextKeyState(prev, e);
      if (next === prev) return prev;
      if (persist) {
        const op = persistOps(prev, next);
        if (op !== 'none') applyPersist(keyFor(requestId), intentId, op, next);
      }
      stateRef.current = next;
      setState(next);
      return next;
    },
    [persist, keyFor, requestId, intentId],
  );

  return { state, dispatch };
}
