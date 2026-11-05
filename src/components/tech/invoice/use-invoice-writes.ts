'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent, type KeyEvent, type KeyState } from '@/lib/tech/invoice-key-state';
import { INTENTS_STORAGE_KEY, parseIntents } from '@/lib/tech/invoice-intent-persist';
import { writeErrorCopy } from '@/lib/tech/invoice-page-copy';
import {
  intentFromBody,
  intentLanded,
  sendPlan,
  writeStatus,
  type Intent,
  type IntentKind,
  type WriteStatus,
} from '@/lib/tech/invoice-view-diff';
import type { TechInvoiceView } from '@/lib/tech/invoice-view';
import { sendStored, type SendResult } from './post-json';

/**
 * done = the server accepted it (or a replay said so); dropped = the refetch
 * showed it landed; retry = still unknown, "Try again" re-sends with the SAME
 * key; pending = the server still holds the key (IN_PROGRESS): show the
 * message as status, not as an error; error = definitive refusal (message
 * shown); skipped = nothing sent (a double tap while in flight, or a pending
 * write).
 */
export interface WriteResult {
  readonly status: WriteStatus;
  readonly message: string | null;
  readonly data?: unknown;
}

export type WriteFn = (
  intent: Intent,
  send: (key: string) => Promise<SendResult>,
  /** The HTTP body (part of the key's body hash and what a reload re-sends). */
  body: unknown,
  /** Override for bodies JSON can't hash (the signature Blob). */
  bodyHash?: string,
) => Promise<WriteResult>;

const PERSISTED: readonly IntentKind[] = ['create', 'add_line', 'remove_line', 'finalize', 'payment', 'pay_link'];
const SIGNATURE_RETRY = 'Your last signature may not have saved. Try again.';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether a reload left in-flight intents to re-send (false on the server). */
function hasStoredIntents(jobId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Object.keys(parseIntents(window.sessionStorage.getItem(INTENTS_STORAGE_KEY(jobId)))).length > 0;
  } catch {
    return false;
  }
}

/**
 * The key reducer per intent kind plus the write loop of spec §7.5–7.6.
 * One `useIdempotencyKey` per kind (hooks need a fixed order); the signature
 * intent is never persisted (its body is a Blob).
 */
export function useInvoiceWrites(opts: {
  jobId: string;
  viewRef: RefObject<TechInvoiceView | null>;
  refetch: () => Promise<TechInvoiceView | null>;
}) {
  const { jobId, viewRef, refetch } = opts;
  const create = useIdempotencyKey({ intentId: 'create', requestId: jobId, persist: true });
  const addLine = useIdempotencyKey({ intentId: 'add_line', requestId: jobId, persist: true });
  const removeLine = useIdempotencyKey({ intentId: 'remove_line', requestId: jobId, persist: true });
  const finalize = useIdempotencyKey({ intentId: 'finalize', requestId: jobId, persist: true });
  const payment = useIdempotencyKey({ intentId: 'payment', requestId: jobId, persist: true });
  const payLink = useIdempotencyKey({ intentId: 'pay_link', requestId: jobId, persist: true });
  const signature = useIdempotencyKey({ intentId: 'signature', requestId: jobId, persist: false });
  const states: Record<IntentKind, KeyState> = {
    create: create.state, add_line: addLine.state, remove_line: removeLine.state, finalize: finalize.state,
    payment: payment.state, pay_link: payLink.state, signature: signature.state,
  };
  // Each hook's dispatch is stable (useCallback on stable ids), so this is too.
  const dispatchers = useMemo<Record<IntentKind, (e: KeyEvent) => KeyState>>(
    () => ({
      create: create.dispatch, add_line: addLine.dispatch, remove_line: removeLine.dispatch,
      finalize: finalize.dispatch, payment: payment.dispatch, pay_link: payLink.dispatch,
      signature: signature.dispatch,
    }),
    [create.dispatch, addLine.dispatch, removeLine.dispatch, finalize.dispatch, payment.dispatch, payLink.dispatch, signature.dispatch],
  );
  const [busy, setBusy] = useState<IntentKind | null>(null);
  // True until any rehydrated `unknown` intent has been re-sent (edits wait).
  const [recovering, setRecovering] = useState(() => hasStoredIntents(jobId));

  const run = useCallback(
    async (kind: IntentKind, intent: Intent, sent: KeyState, doSend: (key: string) => Promise<SendResult>): Promise<WriteResult> => {
      if (sent.phase !== 'sent') return { status: 'skipped', message: null };
      const before = viewRef.current ?? (await refetch());
      setBusy(kind);
      try {
        const res = await doSend(sent.key);
        const env = res.status === null ? null : res.envelope;
        const outcome = classifyWriteError(res.status, env?.error?.code ?? null, env?.error?.details);
        if (outcome === 'wait_then_refetch') await sleep(2000);
        const after = await refetch();
        const landed = before !== null && after !== null && intentLanded(intent, before, after);
        const ev = outcomeEvent(outcome, landed);
        if (ev) dispatchers[kind]({ type: ev });
        const message = writeErrorCopy(outcome, env, ev === 'dropped');
        return { status: writeStatus(outcome, ev), message, data: env?.data };
      } finally {
        setBusy(null);
      }
    },
    [viewRef, refetch, dispatchers],
  );

  /** Re-send a stored intent with its OLD body and OLD key. */
  const retry = useCallback(
    async (kind: IntentKind): Promise<WriteResult> => {
      // The signature body (a Blob) is never stored: only the caller can re-send
      // it, by calling write() again with the SAME bodyHash (same key).
      if (kind === 'signature') return { status: 'retry', message: SIGNATURE_RETRY };
      const s = dispatchers[kind]({ type: 'sent' });
      if (s.phase !== 'sent') return { status: 'skipped', message: null };
      return run(kind, intentFromBody(kind, s.body), s, (key) =>
        sendStored(jobId, kind, s.body, key) ?? Promise.resolve({ status: null }),
      );
    },
    [jobId, run, dispatchers],
  );

  const write: WriteFn = useCallback(
    async (intent, send, body, bodyHash) => {
      if (viewRef.current?.pendingWrite) return { status: 'skipped', message: 'Still saving your last tap…' };
      const dispatch = dispatchers[intent.kind];
      const hash = bodyHash ?? JSON.stringify(body ?? {});
      dispatch({ type: 'open', bodyHash: hash, body, mint: mintKey });
      const pre = dispatch({ type: 'edit', bodyHash: hash, body, mint: mintKey });
      const plan = sendPlan(pre, hash);
      if (plan === 'skip') return { status: 'skipped', message: null };
      if (plan === 'resend_stored') {
        const r = await retry(intent.kind);
        return r.status === 'done' || r.status === 'dropped'
          ? { ...r, status: 'error', message: 'Your earlier change was saved first. Check the invoice and try again.' }
          : r;
      }
      return run(intent.kind, intent, dispatch({ type: 'sent' }), send);
    },
    [viewRef, retry, run, dispatchers],
  );

  // Reload recovery: the key hooks rehydrated in their own (earlier) effects;
  // re-send each stored intent before edits are enabled.
  const recovered = useRef(false);
  useEffect(() => {
    if (recovered.current) return;
    recovered.current = true;
    let stored: string[] = [];
    try {
      stored = Object.keys(parseIntents(window.sessionStorage.getItem(INTENTS_STORAGE_KEY(jobId))));
    } catch {
      stored = [];
    }
    const kinds = PERSISTED.filter((k) => stored.includes(k));
    void (async () => {
      for (const kind of kinds) await retry(kind);
      setRecovering(false);
    })();
  }, [jobId, retry]);

  /** Forget an intent a refetch made moot (back to idle; its stored copy is cleared). */
  const drop = useCallback((kind: IntentKind) => void dispatchers[kind]({ type: 'dropped' }), [dispatchers]);

  const unknownKinds = [...PERSISTED, 'signature' as const].filter((k) => states[k].phase === 'unknown');
  const inFlight = (kind: IntentKind) => states[kind].phase === 'sent' || busy === kind;
  return { write, retry, drop, busy, recovering, unknownKinds, inFlight };
}

/** What the page hands to the Task 14 sheets. */
export interface InvoicePageApi {
  readonly view: TechInvoiceView;
  refetch(): Promise<TechInvoiceView | null>;
  readonly write: WriteFn;
}
