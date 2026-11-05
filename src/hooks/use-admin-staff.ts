'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { StaffRecord } from '@/lib/admin/types';
import type { SeatUsage } from '@/lib/admin/seat-usage';

interface UseAdminStaffResult {
  readonly staff: readonly StaffRecord[];
  /** The signed-in admin's own user id, so the UI can disable self-demote. */
  readonly currentUserId: string | null;
  /** Active users vs the plan's limit; null until loaded. */
  readonly seats: SeatUsage | null;
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
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchStaff = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/staff');

      if (!res.ok) {
        setError("Couldn't load your team. Please try again.");
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: { staff: StaffRecord[]; currentUserId: string; seats?: SeatUsage };
      };

      if (body.success) {
        setStaff(body.data.staff);
        setCurrentUserId(body.data.currentUserId);
        setSeats(body.data.seats ?? null);
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

  return { staff, currentUserId, seats, isLoading, error, refetch: fetchStaff };
}
