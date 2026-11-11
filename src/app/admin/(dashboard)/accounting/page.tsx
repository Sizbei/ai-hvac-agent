import type { Metadata } from 'next';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { AccountingExportPanel } from '@/components/admin/accounting/accounting-export-panel';
import { getViewerContext } from '@/lib/auth/viewer';
import { canExportAccounting } from '@/lib/admin/preview-view';

export const metadata: Metadata = { title: 'Accounting' };

/**
 * Accounting export page. The page renders for any admin (the dashboard layout
 * gates auth). The server decides from the viewer's role (the "View as"
 * target's while previewing) whether the export panel shows; the export
 * endpoint stays super_admin-gated on the real session. While previewing, the
 * panel renders with Download disabled (the read-only proxy refuses the
 * export's audit write).
 */
export default async function AccountingPage() {
  const viewer = await getViewerContext();
  const canExport = viewer !== null && canExportAccounting(viewer.uiRole);
  return (
    <PageShell narrow>
      <PageHeader
        title="Accounting"
        subtitle="Export your books to QuickBooks or any accounting tool."
      />
      {canExport ? (
        <AccountingExportPanel readOnly={viewer.preview !== null} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only a super admin can download accounting exports.
        </p>
      )}
    </PageShell>
  );
}
