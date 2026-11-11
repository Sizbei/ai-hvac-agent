'use client';

import { createContext, useContext } from 'react';
import { NO_BILLING_ENTRY, type BillingEntry } from '@/lib/admin/billing-entry';

/**
 * The viewer's billing entry (`resolveBillingEntry`, decided by the dashboard
 * layout and provided by DashboardShell): whether billing links show and who
 * handles billing. Presentation only: the billing APIs keep their own gates.
 */
const BillingEntryContext = createContext<BillingEntry>(NO_BILLING_ENTRY);

export const BillingEntryProvider = BillingEntryContext.Provider;

export function useBillingEntry(): BillingEntry {
  return useContext(BillingEntryContext);
}
