import { notFound } from 'next/navigation';
import { InvoicePageClient } from '@/components/tech/invoice/invoice-page-client';
import { isUuid } from '@/lib/validation/uuid';

/**
 * S40 — the technician's field invoice for one job. Server shell: the client
 * fetches GET /api/tech/jobs/[id]/invoice (tech-session + ownership guarded).
 * Next.js 16: params and searchParams are Promises. `?addItem=1` opens the Add
 * item sheet on load in development only (screenshot aid).
 */
export default async function TechJobInvoicePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ addItem?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { addItem } = await searchParams;
  const devOpenAddItem = process.env.NODE_ENV !== 'production' && addItem === '1';
  return <InvoicePageClient id={id} devOpenAddItem={devOpenAddItem} />;
}
