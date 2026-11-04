'use client';

import { Button } from '@/components/ui/button';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import type { InvoicePageApi } from './use-invoice-writes';

/**
 * MOUNT POINT for Task 14: "Customer approval", "Record payment" and "Send pay
 * link". They render DISABLED until Task 14 replaces each with its sheet
 * trigger (approval-sheet / record-payment-sheet / pay-link-sheet), wired
 * through the page client's `InvoicePageApi` ({ view, refetch, write }).
 */
export function InvoiceCollectButtons({
  api,
  invoice,
}: {
  readonly api: InvoicePageApi;
  readonly invoice: TechInvoice;
}) {
  const { view } = api;
  const showApproval = invoice.state === 'draft' && invoice.lines.length > 0;
  const showRecord = view.allowed.includes('record_payment') && invoice.balanceCents > 0;
  const showPayLink = view.allowed.includes('pay_link');
  if (!showApproval && !showRecord && !showPayLink) return null;
  const soon = <span className="sr-only"> (Coming in the next step)</span>;
  return (
    <div className="space-y-2">
      {showApproval && (
        <Button className="h-12 w-full rounded-xl text-[16px]" disabled>
          Customer approval{soon}
        </Button>
      )}
      {showRecord && (
        <Button className="h-12 w-full rounded-xl text-[16px]" disabled>
          Record payment{soon}
        </Button>
      )}
      {showPayLink && (
        <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled>
          Send pay link{soon}
        </Button>
      )}
    </div>
  );
}
