import { notFound } from 'next/navigation';
import { EstimateBuilderClient } from '@/components/tech/estimates/estimate-builder-client';
import { isUuid } from '@/lib/validation/uuid';

/** Field estimate builder (M3c spec §7.1). Next.js 16: params is a Promise. */
export default async function NewEstimatePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <EstimateBuilderClient jobId={id} />;
}
