/**
 * Thin fetch wrappers for the field invoice writes. They never throw: a network
 * error is `{ status: null }`, so `classifyWriteError` can decide what to do.
 */
import type { IntentKind } from '@/lib/tech/invoice-view-diff';

export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: { storedStatus?: number } };
}

export type SendResult = { readonly status: number; readonly envelope: Envelope | null } | { readonly status: null };

async function call(path: string, init: RequestInit): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { status: null };
  }
  const envelope = (await res.json().catch(() => null)) as Envelope | null;
  return { status: res.status, envelope };
}

export function postJson(path: string, body: unknown, key: string): Promise<SendResult> {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body ?? {}),
  });
}

export function deleteJson(path: string): Promise<SendResult> {
  return call(path, { method: 'DELETE' });
}

/** Rebuild the request for a stored (persisted) intent body, so an `unknown`
 * intent can be re-sent with its OLD body and OLD key after a reload. The
 * signature (multipart, never persisted) is not rebuildable: null. */
export function sendStored(jobId: string, kind: IntentKind, body: unknown, key: string): Promise<SendResult> | null {
  const base = `/api/tech/jobs/${jobId}/invoice`;
  const b = (body ?? {}) as { invoiceId?: string; lineId?: string };
  switch (kind) {
    case 'create':
      return postJson(base, {}, key);
    case 'add_line':
      return postJson(`${base}/lines`, body, key);
    case 'remove_line':
      if (!b.lineId || !b.invoiceId) return null;
      return deleteJson(`${base}/lines/${b.lineId}?invoiceId=${encodeURIComponent(b.invoiceId)}`);
    case 'finalize':
      return postJson(`${base}/finalize`, body, key);
    case 'payment':
      return postJson(`${base}/payments`, body, key);
    case 'pay_link':
      return postJson(`${base}/pay-link`, body, key);
    case 'signature':
      return null;
  }
}
