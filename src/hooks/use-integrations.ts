'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export type IntegrationCategory =
  | 'FSM'
  | 'payments'
  | 'financing'
  | 'comms'
  | 'ai';

export type IntegrationStatus =
  | 'live'
  | 'mock'
  | 'connected'
  | 'not_configured';

export interface IntegrationStatusItem {
  readonly key: string;
  readonly label: string;
  readonly category: IntegrationCategory;
  readonly status: IntegrationStatus;
  readonly detail: string;
  readonly configurable: boolean;
  readonly manageHref?: string;
}

interface UseIntegrationsResult {
  readonly integrations: IntegrationStatusItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}

/**
 * Loads the org's derived integration statuses. Read at human pace — no polling.
 * Modeled on use-reports.
 */
export function useIntegrations(): UseIntegrationsResult {
  const [integrations, setIntegrations] = useState<IntegrationStatusItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);

  const fetchStatus = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/integrations');
      if (!res.ok) {
        setError('Failed to load integrations');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { integrations: IntegrationStatusItem[] };
      };
      if (body.success) {
        setIntegrations(body.data.integrations);
      }
      setError(null);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchStatus().finally(() => setIsLoading(false));
  }, [fetchStatus]);

  return { integrations, isLoading, error, refetch: fetchStatus };
}
