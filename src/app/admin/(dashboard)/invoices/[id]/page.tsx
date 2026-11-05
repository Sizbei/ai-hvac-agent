import { getAdminSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/authz';
import { InvoiceDetailClient } from '@/components/admin/invoices/invoice-detail-client';
import { cardPaymentsEnabled } from '@/lib/payments/card-enabled';

/**
 * Thin server wrapper — no PageShell here; PageShell lives in InvoiceDetailClient.
 * Server wrapper: reads the session role so the refund control is only RENDERED
 * for a super_admin. The /api/admin/payments/[id]/refund route enforces the gate
 * regardless — this is purely UI hygiene (don't show a button that 403s).
 */
export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // Set by the estimate page's Generate invoice so this page can confirm it.
  const justCreated = (await searchParams).created === '1';
  const session = await getAdminSession();
  const canRefund = session ? isSuperAdmin(session) : false;

  return (
    <InvoiceDetailClient
      id={id}
      canRefund={canRefund}
      cardPaymentsEnabled={cardPaymentsEnabled()}
      justCreated={justCreated}
    />
  );
}
