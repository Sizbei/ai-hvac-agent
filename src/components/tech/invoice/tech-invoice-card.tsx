import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { invoiceChipLabel } from '@/lib/tech/invoice-page-copy';

const ON_SITE: readonly string[] = ['arrived', 'in_progress', 'on_hold', 'completed'];

/**
 * The job page's Invoice card (spec §7 entry): shown once the request is on
 * site. Native lead → chip + "Open invoice"; helper → chip + who handles it;
 * a synced (FieldPulse/HCP) job → "Invoice in FieldPulse.".
 */
export function TechInvoiceCard({
  jobId,
  native,
  status,
  isLead,
  invoiceSummary,
}: {
  readonly jobId: string;
  readonly native: boolean;
  readonly status: string;
  readonly isLead: boolean;
  readonly invoiceSummary: { readonly state: string; readonly balanceCents: number } | null;
}) {
  if (!ON_SITE.includes(status)) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-[17px]">Invoice</CardTitle>
          {native && (
            <span className="shrink-0 rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
              {invoiceChipLabel(invoiceSummary)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!native ? (
          <p className="text-[15px] text-muted-foreground">Invoice in FieldPulse.</p>
        ) : isLead ? (
          <Link
            href={`/tech/jobs/${jobId}/invoice`}
            className="flex min-h-11 items-center justify-between rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium text-foreground active:bg-accent"
          >
            Open invoice <ChevronRight className="size-4" />
          </Link>
        ) : (
          <p className="text-[15px] text-muted-foreground">The lead technician handles the invoice.</p>
        )}
      </CardContent>
    </Card>
  );
}
