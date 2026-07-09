'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CustomerListRecord, CustomerDetail } from '@/lib/admin/crm-types';
import { createSwrCache } from '@/lib/admin/swr-cache';

interface CustomersPayload {
  readonly customers: readonly CustomerListRecord[];
}

const customersCache = createSwrCache<CustomersPayload>(60_000); // 60s TTL

export function useAdminCustomers(includeArchived?: boolean) {
  const shouldIncludeArchived = includeArchived ?? false;
  const [customers, setCustomers] = useState<readonly CustomerListRecord[]>([]);
  // Start as loading only if there is no cached data to show immediately.
  const [isLoading, setIsLoading] = useState(
    () => customersCache.get('customers:' + String(shouldIncludeArchived)) === null,
  );
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async ({ bust = false }: { bust?: boolean } = {}) => {
    const key = 'customers:' + String(shouldIncludeArchived);

    if (bust) {
      customersCache.invalidate(key);
    }

    const cached = customersCache.get(key);
    const hasCachedData = cached !== null;

    if (hasCachedData) {
      setCustomers(cached.data.customers);
    }

    try {
      const url = shouldIncludeArchived
        ? '/api/admin/customers?includeArchived=true'
        : '/api/admin/customers';
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setError(null);
        setCustomers(json.data.customers);
        customersCache.set(key, { customers: json.data.customers });
      } else {
        if (!hasCachedData) {
          setError(json.error?.message ?? 'Failed to load customers');
        }
      }
    } catch {
      if (!hasCachedData) {
        setError('Network error');
      }
    } finally {
      setIsLoading(false);
    }
  }, [shouldIncludeArchived]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetch_();
  }, [fetch_]);

  const refetch = useCallback(() => fetch_({ bust: true }), [fetch_]);

  return { customers, isLoading, error, refetch } as const;
}

export function useCustomerDetail(customerId: string) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/customers/${customerId}`);
      const json = await res.json();
      if (json.success) {
        setCustomer(json.data);
        setError(null); // clear any prior failure so a recovered refetch isn't stuck showing an error
      } else {
        setError(json.error?.message ?? 'Customer not found');
      }
    } catch {
      setError('Network error');
    } finally {
      setIsLoading(false);
    }
  }, [customerId]);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { customer, isLoading, error, refetch: fetch_ } as const;
}
