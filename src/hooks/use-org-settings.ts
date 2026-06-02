'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  OrgConfig,
  OrgConfigUpdate,
  CustomFaq,
  CustomFaqInput,
} from '@/lib/admin/org-config-types';

interface UseOrgSettingsResult {
  readonly config: OrgConfig | null;
  readonly faqs: readonly CustomFaq[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly saveConfig: (update: OrgConfigUpdate) => Promise<boolean>;
  readonly createFaq: (input: CustomFaqInput) => Promise<boolean>;
  readonly updateFaq: (
    id: string,
    input: Partial<CustomFaqInput>,
  ) => Promise<boolean>;
  readonly deleteFaq: (id: string) => Promise<boolean>;
  readonly refetch: () => Promise<void>;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? fallback;
}

export function useOrgSettings(): UseOrgSettingsResult {
  const [config, setConfig] = useState<OrgConfig | null>(null);
  const [faqs, setFaqs] = useState<readonly CustomFaq[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const [cfgRes, faqRes] = await Promise.all([
        fetch('/api/admin/settings'),
        fetch('/api/admin/settings/faqs'),
      ]);
      if (!cfgRes.ok) {
        setError(await readError(cfgRes, 'Failed to load settings'));
        return;
      }
      const cfgBody = (await cfgRes.json()) as {
        data: { config: OrgConfig };
      };
      setConfig(cfgBody.data.config);
      if (faqRes.ok) {
        const faqBody = (await faqRes.json()) as {
          data: { faqs: CustomFaq[] };
        };
        setFaqs(faqBody.data.faqs);
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
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  const saveConfig = useCallback(
    async (update: OrgConfigUpdate): Promise<boolean> => {
      try {
        const res = await fetch('/api/admin/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        });
        if (!res.ok) {
          setError(await readError(res, 'Failed to save settings'));
          return false;
        }
        const body = (await res.json()) as { data: { config: OrgConfig } };
        setConfig(body.data.config);
        setError(null);
        return true;
      } catch {
        setError('Could not connect to server. Please try again.');
        return false;
      }
    },
    [],
  );

  const createFaq = useCallback(
    async (input: CustomFaqInput): Promise<boolean> => {
      try {
        const res = await fetch('/api/admin/settings/faqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          setError(await readError(res, 'Failed to create FAQ'));
          return false;
        }
        const body = (await res.json()) as { data: { faq: CustomFaq } };
        setFaqs((prev) => [body.data.faq, ...prev]);
        setError(null);
        return true;
      } catch {
        setError('Could not connect to server. Please try again.');
        return false;
      }
    },
    [],
  );

  const updateFaq = useCallback(
    async (id: string, input: Partial<CustomFaqInput>): Promise<boolean> => {
      try {
        const res = await fetch(`/api/admin/settings/faqs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          setError(await readError(res, 'Failed to update FAQ'));
          return false;
        }
        const body = (await res.json()) as { data: { faq: CustomFaq } };
        setFaqs((prev) => prev.map((f) => (f.id === id ? body.data.faq : f)));
        setError(null);
        return true;
      } catch {
        setError('Could not connect to server. Please try again.');
        return false;
      }
    },
    [],
  );

  const deleteFaq = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/settings/faqs/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(await readError(res, 'Failed to delete FAQ'));
        return false;
      }
      setFaqs((prev) => prev.filter((f) => f.id !== id));
      setError(null);
      return true;
    } catch {
      setError('Could not connect to server. Please try again.');
      return false;
    }
  }, []);

  return {
    config,
    faqs,
    isLoading,
    error,
    saveConfig,
    createFaq,
    updateFaq,
    deleteFaq,
    refetch: fetchAll,
  };
}
