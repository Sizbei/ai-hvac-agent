'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AuditLogEntry } from '@/lib/admin/audit-types';

interface UseAdminAuditLogOptions {
  readonly action?: string;
  readonly entity?: string;
  readonly page?: number;
  readonly limit?: number;
}

interface UseAdminAuditLogResult {
  readonly entries: readonly AuditLogEntry[];
  readonly total: number;
  readonly actions: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Fetches the admin audit log, paginated and optionally filtered by action.
 * No polling — the audit trail is a historical record, refetched only when the
 * filter or page changes (or on explicit refetch).
 */
export function useAdminAuditLog(
  options: UseAdminAuditLogOptions = {},
): UseAdminAuditLogResult {
  const { action, entity, page = 1, limit = 50 } = options;

  const [entries, setEntries] = useState<readonly AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<readonly string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchAuditLog = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setIsLoading(true);

    try {
      const params = new URLSearchParams();
      if (action) params.set('action', action);
      if (entity) params.set('entity', entity);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const res = await fetch(`/api/admin/audit-log?${params.toString()}`);

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch audit log' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch audit log');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: {
          entries: AuditLogEntry[];
          total: number;
          actions: string[];
          page: number;
          limit: number;
        };
      };

      if (body.success) {
        setEntries(body.data.entries);
        setTotal(body.data.total);
        setActions(body.data.actions);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, [action, entity, page, limit]);

  useEffect(() => {
    void fetchAuditLog();
  }, [fetchAuditLog]);

  return {
    entries,
    total,
    actions,
    isLoading,
    error,
    refetch: fetchAuditLog,
  };
}
