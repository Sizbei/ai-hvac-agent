import { AccountingExportPanel } from '@/components/admin/accounting/accounting-export-panel';

/**
 * Accounting export page. The page renders for any admin (the dashboard layout
 * gates auth), but the export panel self-hides for non-super_admins: it probes
 * the super_admin-gated export endpoint and renders nothing on 403. The server,
 * not the client, is the authority for visibility and access.
 */
export default function AccountingPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accounting</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Export your books to QuickBooks or any accounting tool.
        </p>
      </div>
      <AccountingExportPanel />
    </div>
  );
}
