import type { SiteView } from '@/lib/tech/site-view';

/** GET the Site view; never throws. */
export async function fetchSite(jobId: string): Promise<SiteView | null> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/site`);
    const body = await res.json().catch(() => null);
    return res.ok && body?.success ? (body.data as SiteView) : null;
  } catch {
    return null;
  }
}
