import { notFound } from 'next/navigation';
import { SitePageClient } from '@/components/tech/site/site-page-client';
import { isUuid } from '@/lib/validation/uuid';

/** The Site page (M3d spec §7.6), reached from the job page's Site card. Next.js 16: params is a Promise. */
export default async function TechSitePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <SitePageClient jobId={id} />;
}
