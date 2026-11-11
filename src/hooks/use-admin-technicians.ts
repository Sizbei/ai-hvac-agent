'use client';

import { useState, useEffect, useCallback } from 'react';
import type { TechnicianRecord } from '@/lib/admin/types';

interface UseAdminTechniciansResult {
  readonly technicians: readonly TechnicianRecord[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/** How long one technicians response is shared before it is fetched again. */
const SHARE_MS = 30_000;

type TechniciansResult =
  | { readonly ok: true; readonly technicians: readonly TechnicianRecord[] }
  | { readonly ok: false; readonly message: string };

let shared: { readonly at: number; readonly promise: Promise<TechniciansResult> } | null = null;
let lastGood: readonly TechnicianRecord[] | null = null;

async function requestTechnicians(): Promise<TechniciansResult> {
  try {
    const res = await fetch('/api/admin/technicians');
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        ok: false,
        message: body?.error?.message ?? 'Couldn’t load technicians. Please try again.',
      };
    }
    const body = (await res.json()) as {
      success: boolean;
      data: { technicians: TechnicianRecord[] };
    };
    if (!body.success) return { ok: false, message: 'Couldn’t load technicians. Please try again.' };
    lastGood = body.data.technicians;
    return { ok: true, technicians: body.data.technicians };
  } catch {
    return { ok: false, message: 'Could not connect to server. Please try again.' };
  }
}

/**
 * The technician list, fetched ONCE for everything on the page that needs it
 * (filter bar, create dialog, detail sheet…). Concurrent callers share one
 * request and the answer is reused for SHARE_MS; `bust` forces a new request.
 * A failed request is never cached.
 */
export function loadTechnicians({ bust = false }: { bust?: boolean } = {}): Promise<TechniciansResult> {
  if (!bust && shared && Date.now() - shared.at < SHARE_MS) return shared.promise;
  const promise = requestTechnicians();
  const entry = { at: Date.now(), promise };
  shared = entry;
  void promise.then((r) => {
    if (!r.ok && shared === entry) shared = null;
  });
  return promise;
}

/**
 * Custom hook for fetching the admin technician list.
 * Fetches on mount, no polling (technician list changes infrequently).
 */
export function useAdminTechnicians(): UseAdminTechniciansResult {
  const [technicians, setTechnicians] = useState<readonly TechnicianRecord[]>(() => lastGood ?? []);
  const [isLoading, setIsLoading] = useState(() => lastGood === null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((result: TechniciansResult): void => {
    if (result.ok) {
      setTechnicians(result.technicians);
      setError(null);
    } else {
      setError(result.message);
    }
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    apply(await loadTechnicians({ bust: true }));
  }, [apply]);

  // Fetch on mount (shared with every other consumer on the page).
  useEffect(() => {
    let cancelled = false;
    void loadTechnicians().then((result) => {
      if (cancelled) return;
      apply(result);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  return { technicians, isLoading, error, refetch };
}
