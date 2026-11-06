'use client';

import { useCallback } from 'react';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent, type KeyPhase, type WriteOutcome } from '@/lib/tech/invoice-key-state';
import { ESTIMATE_INTENTS_KEY, type StoredWrite } from '@/lib/tech/estimate-intents';
import { postJson, type Envelope } from '@/components/tech/invoice/post-json';

export type EstimateSend =
  | { readonly sent: false }
  | { readonly sent: true; readonly status: number | null; readonly envelope: Envelope | null; readonly outcome: WriteOutcome; readonly resentOld: boolean };

/**
 * One keyed write (M3c spec §7): the M3b reducer, persisted under the estimate
 * storage key. `rehydrate: false` (default) for surfaces whose mount recovery
 * re-sends stored intents first (builder, estimate page, equipment card);
 * `rehydrate: true` for the equipment sheet, which restores its own intent and
 * re-sends it before Save unlocks (plan ruling 14). A double tap while `sent`
 * sends nothing; an `unknown` intent re-sends its OLD body and OLD key
 * (resentOld tells the caller). After the caller has refetched, it calls
 * `settle(outcome, landed)`.
 */
export function useEstimateWrite(requestId: string, intentId: string, rehydrate = false) {
  const { state, dispatch } = useIdempotencyKey({
    intentId, requestId, persist: true, storageKey: ESTIMATE_INTENTS_KEY, rehydrate,
  });

  const send = useCallback(async (path: string, payload: unknown): Promise<EstimateSend> => {
    const write: StoredWrite = { path, payload };
    const hash = JSON.stringify(write);
    dispatch({ type: 'open', bodyHash: hash, body: write, mint: mintKey });
    const pre = dispatch({ type: 'edit', bodyHash: hash, body: write, mint: mintKey });
    if (pre.phase !== 'armed' && pre.phase !== 'unknown') return { sent: false };
    const s = dispatch({ type: 'sent' });
    if (s.phase !== 'sent') return { sent: false };
    const stored = s.body as StoredWrite;
    const res = await postJson(stored.path, stored.payload, s.key);
    const envelope = res.status === null ? null : res.envelope;
    const outcome = classifyWriteError(res.status, envelope?.error?.code ?? null, envelope?.error?.details);
    return { sent: true, status: res.status, envelope, outcome, resentOld: s.bodyHash !== hash };
  }, [dispatch]);

  const settle = useCallback((outcome: WriteOutcome, landed: boolean): void => {
    const ev = outcomeEvent(outcome, landed);
    if (ev) dispatch({ type: ev });
  }, [dispatch]);

  return { phase: state.phase as KeyPhase, send, settle };
}
