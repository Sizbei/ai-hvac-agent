'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { WidgetKeyRecord } from '@/lib/widget/key-queries';
import type { KeyType } from '@/lib/widget/keys';

interface CreateResult {
  readonly record: WidgetKeyRecord;
  /** Plaintext key — shown ONCE to the admin. */
  readonly plaintext: string;
}

interface UseWidgetKeysResult {
  readonly keys: readonly WidgetKeyRecord[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly createKey: (
    keyType: KeyType,
    label: string,
  ) => Promise<CreateResult | null>;
  readonly revokeKey: (id: string) => Promise<boolean>;
  readonly refetch: () => Promise<void>;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? fallback;
}

export function useWidgetKeys(): UseWidgetKeysResult {
  const [keys, setKeys] = useState<readonly WidgetKeyRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  const fetchKeys = useCallback(async (): Promise<void> => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch('/api/admin/widget-keys');
      if (!res.ok) {
        setError(await readError(res, 'Failed to load keys'));
        return;
      }
      const body = (await res.json()) as { data: { keys: WidgetKeyRecord[] } };
      setKeys(body.data.keys);
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchKeys().finally(() => setIsLoading(false));
  }, [fetchKeys]);

  const createKey = useCallback(
    async (keyType: KeyType, label: string): Promise<CreateResult | null> => {
      try {
        const res = await fetch('/api/admin/widget-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyType, label: label || undefined }),
        });
        if (!res.ok) {
          setError(await readError(res, 'Failed to create key'));
          return null;
        }
        const body = (await res.json()) as {
          data: { key: WidgetKeyRecord; plaintext: string };
        };
        setKeys((prev) => [body.data.key, ...prev]);
        setError(null);
        return { record: body.data.key, plaintext: body.data.plaintext };
      } catch {
        setError('Could not connect to server. Please try again.');
        return null;
      }
    },
    [],
  );

  const revokeKey = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/widget-keys/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(await readError(res, 'Failed to revoke key'));
        return false;
      }
      // Mark revoked locally (we keep revoked keys in the list, greyed out).
      setKeys((prev) =>
        prev.map((k) =>
          k.id === id
            ? { ...k, isActive: false, revokedAt: new Date().toISOString() }
            : k,
        ),
      );
      setError(null);
      return true;
    } catch {
      setError('Could not connect to server. Please try again.');
      return false;
    }
  }, []);

  return { keys, isLoading, error, createKey, revokeKey, refetch: fetchKeys };
}
