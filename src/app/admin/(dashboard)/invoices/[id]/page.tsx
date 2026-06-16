import { getAdminSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/authz';
import { InvoiceDetailClient } from '@/components/admin/invoices/invoice-detail-client';

/**
 * Server wrapper: reads the session role so the refund control is only RENDERED
 * for a super_admin. The /api/admin/payments/[id]/refund route enforces the gate
 * regardless — this is purely UI hygiene (don't show a button that 403s).
 */
export default async function InvoiceDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getAdminSession();
  const canRefund = session ? isSuperAdmin(session) : false;

  return <InvoiceDetailClient id={id} canRefund={canRefund} />;
}
