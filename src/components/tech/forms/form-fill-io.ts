/** The fill page's reads and its leave mark (M3d spec §7.3, ruling R1). Client-only. */
import type { Changes } from '@/lib/forms/form-values';
import type { TechFormView } from '@/lib/tech/form-view';

export async function getView(jobId: string, formId: string, visitId: string): Promise<{ status: number | null; view: TechFormView | null; code: string | null }> {
  try {
    // A dead connection times out into the caller's back-off instead of holding a re-read open forever.
    const res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}?visit=${visitId}`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, view: res.ok && body?.success ? (body.data as TechFormView) : null, code: body?.error?.code ?? null };
  } catch {
    return { status: null, view: null, code: null };
  }
}

/**
 * A leave-time save was sent (hidden / pagehide): the next load of this form
 * may read the row before that save commits, so it reads again. Removed when
 * the save is seen to land. Storage may be unavailable: then nothing is marked.
 */
export const leaveMarkKey = (formId: string, visitId: string): string => `tech:form:leave:${formId}:${visitId}`;

export function writeLeaveMark(key: string, changes: Changes): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), changes }));
  } catch {
    // Storage blocked: the reload shows the row it reads.
  }
}

export function readLeaveMark(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function clearLeaveMark(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
