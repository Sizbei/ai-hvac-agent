'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { StaffRecord } from '@/lib/admin/types';

interface UseAdminStaffResult {
  readonly staff: readonly StaffRecord[];
  /** The signed-in admin's own user id, so the UI can disable self-demote. */
  readonly currentUserId: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Fetches the org's staff list (admins + technicians) plus the caller's own
 * user id. Fetches on mount; no polling — staff changes infrequently.
 */
export function useAdminStaff(): UseAdminStaffResult {
  const [staff, setStaff] = useState<readonly StaffRecord[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchStaff = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/staff');

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch staff' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch staff');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: { staff: StaffRecord[]; currentUserId: string };
      };

      if (body.success) {
        setStaff(body.data.staff);
        setCurrentUserId(body.data.currentUserId);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchStaff().finally(() => setIsLoading(false));
  }, [fetchStaff]);

  return { staff, currentUserId, isLoading, error, refetch: fetchStaff };
}
