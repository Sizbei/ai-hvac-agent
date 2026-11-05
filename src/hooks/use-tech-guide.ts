'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuidePayload } from '@/lib/tech/guide-steps';
import { subscribeGuideRefresh } from '@/lib/tech/guide-refresh';

/** Fetches /api/tech/guide on mount and on the refresh event; keeps the last good payload. */
export function useTechGuide() {
  const [data, setData] = useState<GuidePayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed'>('loading');
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const res = await fetch('/api/tech/guide');
      const body = await res.json().catch(() => null);
      if (mine !== seq.current) return;
      if (res.ok && body?.success) {
        setData(body.data as GuidePayload);
        setStatus('ok');
      } else {
        setStatus('failed');
      }
    } catch {
      if (mine === seq.current) setStatus('failed');
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeGuideRefresh(() => void reload());
  }, [reload]);

  return { data, status, reload };
}
