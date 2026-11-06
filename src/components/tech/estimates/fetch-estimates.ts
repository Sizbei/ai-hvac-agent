/** GET the job's estimates. hidden = not readable (404) or not native (409). Never throws. */
import type { TechEstimatesView } from '@/lib/tech/estimate-view';

export type EstimatesFetch = { readonly kind: 'ok'; readonly view: TechEstimatesView } | { readonly kind: 'hidden' } | { readonly kind: 'error' };

export async function fetchEstimates(jobId: string): Promise<EstimatesFetch> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/estimates`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: TechEstimatesView } | null;
    if (res.ok && body?.success && body.data) return { kind: 'ok', view: body.data };
    if (res.status === 404 || res.status === 409) return { kind: 'hidden' };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}
