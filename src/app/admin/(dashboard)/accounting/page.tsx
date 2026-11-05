import type { Metadata } from 'next';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { AccountingExportPanel } from '@/components/admin/accounting/accounting-export-panel';

export const metadata: Metadata = { title: 'Accounting' };

/**
 * Accounting export page. The page renders for any admin (the dashboard layout
 * gates auth), but the export panel self-hides for non-super_admins: it probes
 * the super_admin-gated export endpoint and renders nothing on 403. The server,
 * not the client, is the authority for visibility and access.
 */
export default function AccountingPage() {
  return (
    <PageShell narrow>
      <PageHeader
        title="Accounting"
        subtitle="Export your books to QuickBooks or any accounting tool."
      />
      <AccountingExportPanel />
    </PageShell>
  );
}
