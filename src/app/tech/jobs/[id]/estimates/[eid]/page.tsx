import { notFound } from 'next/navigation';
import { EstimatePageClient } from '@/components/tech/estimates/estimate-page-client';
import { isUuid } from '@/lib/validation/uuid';

/** The lead's estimate page with the #customer layer (M3c spec §7.2–§7.3). Next.js 16: params is a Promise. */
export default async function TechEstimatePage({ params }: { readonly params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await params;
  if (!isUuid(id) || !isUuid(eid)) notFound();
  return <EstimatePageClient jobId={id} estimateId={eid} />;
}
