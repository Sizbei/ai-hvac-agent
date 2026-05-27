'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TechnicianRecord } from '@/lib/admin/types';

interface UseAdminTechniciansResult {
  readonly technicians: readonly TechnicianRecord[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Custom hook for fetching the admin technician list.
 * Fetches on mount, no polling (technician list changes infrequently).
 */
export function useAdminTechnicians(): UseAdminTechniciansResult {
  const [technicians, setTechnicians] = useState<readonly TechnicianRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchTechnicians = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/technicians');

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch technicians' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch technicians');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: { technicians: TechnicianRecord[] };
      };

      if (body.success) {
        setTechnicians(body.data.technicians);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    setIsLoading(true);
    fetchTechnicians().finally(() => setIsLoading(false));
  }, [fetchTechnicians]);

  return { technicians, isLoading, error, refetch: fetchTechnicians };
}
