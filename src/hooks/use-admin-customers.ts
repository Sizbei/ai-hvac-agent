'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CustomerRecord, CustomerDetail } from '@/lib/admin/crm-types';

export function useAdminCustomers() {
  const [customers, setCustomers] = useState<readonly CustomerRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/customers');
      const json = await res.json();
      if (json.success) {
        setError(null);
        setCustomers(json.data.customers);
      } else {
        setError(json.error?.message ?? 'Failed to load customers');
      }
    } catch {
      setError('Network error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetch_();
  }, [fetch_]);

  return { customers, isLoading, error, refetch: fetch_ } as const;
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
