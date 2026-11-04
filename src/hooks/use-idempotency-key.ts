'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { nextKeyState, type KeyEvent, type KeyState } from '@/lib/tech/invoice-key-state';
import { INTENTS_STORAGE_KEY, parseIntents, persistOps, serializeIntents } from '@/lib/tech/invoice-intent-persist';

const IDLE: KeyState = { phase: 'idle' };

/** Read-modify-write this request's intent map. Storage can throw (private
 * mode, quota); persistence is then best effort and the in-memory state rules. */
function applyPersist(requestId: string, intentId: string, op: 'write' | 'clear', next: KeyState): void {
  try {
    const storageKey = INTENTS_STORAGE_KEY(requestId);
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
 * One idempotency intent (spec §7.5). `dispatch` runs `nextKeyState`
 * synchronously against the latest state, persists the transition BEFORE it
 * returns (so `dispatch({ type: 'sent' })` is on disk before the caller's
 * fetch), and returns the new state so the caller can read the key at once.
 * `persist: false` for the signature intent (its body is a Blob).
 */
export function useIdempotencyKey(opts: {
  intentId: string;
  requestId: string;
  persist: boolean;
}): { state: KeyState; dispatch(e: KeyEvent): KeyState } {
  const { intentId, requestId, persist } = opts;
  const [state, setState] = useState<KeyState>(IDLE);
  const stateRef = useRef<KeyState>(IDLE);

  // Rehydrate an in-flight intent after a reload (a persisted `sent` comes back
  // as `unknown`). Runs after mount: sessionStorage does not exist on the server.
  useEffect(() => {
    if (!persist) return;
    let restored: KeyState | undefined;
    try {
      restored = parseIntents(window.sessionStorage.getItem(INTENTS_STORAGE_KEY(requestId)))[intentId];
    } catch {
      restored = undefined;
    }
    if (restored && stateRef.current.phase === 'idle') {
      stateRef.current = restored;
      setState(restored);
    }
  }, [persist, requestId, intentId]);

  const dispatch = useCallback(
    (e: KeyEvent): KeyState => {
      const prev = stateRef.current;
      const next = nextKeyState(prev, e);
      if (next === prev) return prev;
      if (persist) {
        const op = persistOps(prev, next);
        if (op !== 'none') applyPersist(requestId, intentId, op, next);
      }
      stateRef.current = next;
      setState(next);
      return next;
    },
    [persist, requestId, intentId],
  );

  return { state, dispatch };
}
