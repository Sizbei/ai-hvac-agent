'use client';

import { createContext, useContext } from 'react';

/**
 * Whether platform-only UI shows: the platform owner, not previewing
 * (`seesPlatformUi`, decided by the dashboard layout and provided by
 * DashboardShell). Presentation only: the APIs keep their own gates.
 */
const PlatformUiContext = createContext(false);

export const PlatformUiProvider = PlatformUiContext.Provider;

export function usePlatformUi(): boolean {
  return useContext(PlatformUiContext);
}
