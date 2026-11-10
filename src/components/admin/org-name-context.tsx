'use client';

import { createContext, useContext, useEffect } from 'react';
import { adminPageTitle } from '@/lib/admin/admin-title';

/** The signed-in org's display name, provided by DashboardShell. */
const OrgNameContext = createContext<string | undefined>(undefined);

export const OrgNameProvider = OrgNameContext.Provider;

export function useOrgName(): string | undefined {
  return useContext(OrgNameContext);
}

/**
 * Set the tab title to "<page> · <org name>" for a client admin page. Next's
 * streamed metadata can write the layout's default title AFTER this effect
 * runs (pages behind a Suspense boundary), so keep re-applying it while the
 * page is mounted.
 */
export function useAdminPageTitle(page: string): void {
  const orgName = useContext(OrgNameContext);
  useEffect(() => {
    const title = adminPageTitle(page, orgName);
    const apply = (): void => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [page, orgName]);
}
