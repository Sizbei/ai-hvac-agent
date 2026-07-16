'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CustomerListRecord, CustomerDetail } from '@/lib/admin/crm-types';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface CustomersPayload {
  readonly customers: readonly CustomerListRecord[];
  readonly total: number;
  readonly propertyTypes: readonly string[];
}

const customersCache = createSwrCache<CustomersPayload>(60_000); // 60s TTL

interface UseAdminCustomersParams {
  readonly includeArchived?: boolean;
  readonly page?: number;
  readonly search?: string;
  readonly propertyType?: string | null;
  readonly customerType?: string | null;
  readonly membershipStatus?: string | null;
  readonly fieldpulseSynced?: boolean;
}

/**
 * Server-paginated customers list. Refetches whenever the page, search,
 * property-type filter, or archived toggle changes. Caller is responsible for
 * debouncing the search term. `total` drives the pager; `propertyTypes` fills
 * the filter dropdown (the client no longer holds every customer to derive it).
 */
export function useAdminCustomers(params: UseAdminCustomersParams = {}) {
  const includeArchived = params.includeArchived ?? false;
  const page = params.page ?? 1;
  const search = params.search ?? '';
  const propertyType = params.propertyType ?? null;
  const customerType = params.customerType ?? null;
  const membershipStatus = params.membershipStatus ?? null;
  const fieldpulseSynced = params.fieldpulseSynced ?? false;

  const key = `customers:${includeArchived}:${page}:${propertyType ?? ''}:${customerType ?? ''}:${membershipStatus ?? ''}:${fieldpulseSynced}:${search}`;

  const [customers, setCustomers] = useState<readonly CustomerListRecord[]>(
    () => customersCache.get(key)?.data.customers ?? [],
  );
  const [total, setTotal] = useState(() => customersCache.get(key)?.data.total ?? 0);
  const [propertyTypes, setPropertyTypes] = useState<readonly string[]>(
    () => customersCache.get(key)?.data.propertyTypes ?? [],
  );
  const [isLoading, setIsLoading] = useState(() => customersCache.get(key) === null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}) => {
      if (bust) customersCache.invalidate(key);

      const cached = customersCache.get(key);
      const hasCachedData = cached !== null;
      if (hasCachedData) {
        setCustomers(cached.data.customers);
        setTotal(cached.data.total);
        setPropertyTypes(cached.data.propertyTypes);
      } else {
        setIsLoading(true);
      }

      try {
        const qs = new URLSearchParams();
        if (includeArchived) qs.set('includeArchived', 'true');
        if (page > 1) qs.set('page', String(page));
        if (search) qs.set('search', search);
        if (propertyType) qs.set('propertyType', propertyType);
        if (customerType) qs.set('customerType', customerType);
        if (membershipStatus) qs.set('membershipStatus', membershipStatus);
        if (fieldpulseSynced) qs.set('fieldpulseSynced', 'true');
        const query = qs.toString();
        const res = await adminFetch(`/api/admin/customers${query ? `?${query}` : ''}`);
        const json = await res.json();
        if (json.success) {
          setError(null);
          setCustomers(json.data.customers);
          setTotal(json.data.total);
          setPropertyTypes(json.data.propertyTypes);
          customersCache.set(key, {
            customers: json.data.customers,
            total: json.data.total,
            propertyTypes: json.data.propertyTypes,
          });
        } else if (!hasCachedData) {
          setError(json.error?.message ?? 'Failed to load customers');
        }
      } catch (err) {
        if (err instanceof AdminAuthRedirectError) return;
        if (!hasCachedData) setError('Network error');
      } finally {
        setIsLoading(false);
      }
    },
    [key, includeArchived, page, search, propertyType, customerType, membershipStatus, fieldpulseSynced],
  );

  // Idiomatic data fetch: setState runs only AFTER the awaited fetch resolves,
  // not synchronously during the effect, so this is not a render loop.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    void fetch_();
  }, [fetch_]);

  const refetch = useCallback(() => fetch_({ bust: true }), [fetch_]);

  return { customers, total, propertyTypes, isLoading, error, refetch } as const;
}

export function useCustomerDetail(customerId: string) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await adminFetch(`/api/admin/customers/${customerId}`);
      const json = await res.json();
      if (json.success) {
        setCustomer(json.data);
        setError(null); // clear any prior failure so a recovered refetch isn't stuck showing an error
      } else {
        setError(json.error?.message ?? 'Customer not found');
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
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
