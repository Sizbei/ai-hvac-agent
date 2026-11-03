'use client';

import { createContext, useContext } from 'react';
import type { SetupPlacement } from '@/components/admin/nav-items';

/**
 * Server-decided Setup placement for this page load, provided by
 * DashboardShell so the home card can skip its skeleton for dismissed or
 * finished orgs (spec §2).
 */
const SetupPlacementContext = createContext<SetupPlacement>('integrations');

export const SetupPlacementProvider = SetupPlacementContext.Provider;

export function useSetupPlacement(): SetupPlacement {
  return useContext(SetupPlacementContext);
}
