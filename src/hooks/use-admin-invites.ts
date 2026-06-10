'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface InviteListItem {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'technician';
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface UseAdminInvitesResult {
  readonly invites: readonly InviteListItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Fetches the org's PENDING invites (not accepted/revoked/expired). Fetches on
 * mount; the caller refetches after create/revoke. Mirrors useAdminStaff.
 */
export function useAdminInvites(): UseAdminInvitesResult {
  const [invites, setInvites] = useState<readonly InviteListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchInvites = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await fetch('/api/admin/invites');
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch invites' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch invites');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { invites: InviteListItem[] };
      };
      if (body.success) {
        setInvites(body.data.invites);
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
    fetchInvites().finally(() => setIsLoading(false));
  }, [fetchInvites]);

  return { invites, isLoading, error, refetch: fetchInvites };
}
