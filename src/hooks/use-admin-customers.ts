'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CustomerListRecord, CustomerDetail } from '@/lib/admin/crm-types';
import { createSwrCache } from '@/lib/admin/swr-cache';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import { isStaleResponse } from '@/lib/admin/tag-picker-logic';

/** Human copy for a failed load; the server's own message never reaches the UI. */
export const CUSTOMERS_LOAD_FAILED = 'Something went wrong on our side. Please try again.';
export const CUSTOMERS_OFFLINE = 'Check your connection, then try again.';

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
  /**
   * False until the caller has read its URL filters. While false the hook
   * neither fetches nor shows cached rows, so a `?q=` link never flashes the
   * unfiltered list first.
   */
  readonly enabled?: boolean;
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
  const enabled = params.enabled ?? true;

  const key = `customers:${includeArchived}:${page}:${propertyType ?? ''}:${customerType ?? ''}:${membershipStatus ?? ''}:${fieldpulseSynced}:${search}`;

  const seed = enabled ? customersCache.get(key) : null;
  const [customers, setCustomers] = useState<readonly CustomerListRecord[]>(
    () => seed?.data.customers ?? [],
  );
  const [total, setTotal] = useState(() => seed?.data.total ?? 0);
  const [propertyTypes, setPropertyTypes] = useState<readonly string[]>(
    () => seed?.data.propertyTypes ?? [],
  );
  const [isLoading, setIsLoading] = useState(() => seed === null);
  const [error, setError] = useState<string | null>(null);
  // Latest request wins: a slower response for an older query (typing "Ri"
  // then "Riverside") must never overwrite the newer one.
  const seqRef = useRef(0);

  const fetch_ = useCallback(
    async ({ bust = false }: { bust?: boolean } = {}) => {
      if (!enabled) return;
      const seq = ++seqRef.current;
      if (bust) customersCache.invalidate(key);

      const cached = customersCache.get(key);
      const hasCachedData = cached !== null;
      // A failed refresh over an out-of-date entry must say so, not pass as current.
      const hasFreshData = customersCache.isFresh(key);
      if (hasCachedData) {
        setError(null);
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
        const json = await res.json().catch(() => null);
        if (isStaleResponse(seq, seqRef.current)) return;
        if (json?.success) {
          setError(null);
          setCustomers(json.data.customers);
          setTotal(json.data.total);
          setPropertyTypes(json.data.propertyTypes);
          customersCache.set(key, {
            customers: json.data.customers,
            total: json.data.total,
            propertyTypes: json.data.propertyTypes,
          });
        } else if (!hasFreshData) {
          setError(CUSTOMERS_LOAD_FAILED);
        }
      } catch (err) {
        if (err instanceof AdminAuthRedirectError) return;
        if (isStaleResponse(seq, seqRef.current)) return;
        if (!hasFreshData) setError(CUSTOMERS_OFFLINE);
      } finally {
        if (!isStaleResponse(seq, seqRef.current)) setIsLoading(false);
      }
    },
    [enabled, key, includeArchived, page, search, propertyType, customerType, membershipStatus, fieldpulseSynced],
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

// Last profile seen per customer: reopening one (or refetching after an edit)
// keeps it on screen while the fresh copy loads, instead of a skeleton.
const customerDetailCache = createSwrCache<CustomerDetail>(60_000);

export function useCustomerDetail(customerId: string) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(
    () => customerDetailCache.get(customerId)?.data ?? null,
  );
  const [isLoading, setIsLoading] = useState(() => customerDetailCache.get(customerId) === null);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    if (customerDetailCache.get(customerId) === null) setIsLoading(true);
    try {
      const res = await adminFetch(`/api/admin/customers/${customerId}`);
      const json = await res.json().catch(() => null);
      if (json?.success) {
        setCustomer(json.data);
        customerDetailCache.set(customerId, json.data);
        setError(null); // clear any prior failure so a recovered refetch isn't stuck showing an error
      } else if (res.status === 404) {
        // No error text: the page shows its own "Customer not found" state.
        customerDetailCache.invalidate(customerId);
        setCustomer(null);
        setError(null);
      } else {
        setError(CUSTOMERS_LOAD_FAILED);
      }
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
      setError(CUSTOMERS_OFFLINE);
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
