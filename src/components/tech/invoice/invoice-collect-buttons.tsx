'use client';

import { Button } from '@/components/ui/button';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import { approvalBlocked } from '@/lib/tech/approval-flow';
import type { IntentKind } from '@/lib/tech/invoice-view-diff';
import { ApprovalSheet } from './approval-sheet';
import { PayLinkSheet } from './pay-link-sheet';
import { RecordPaymentSheet } from './record-payment-sheet';
import type { InvoicePageApi } from './use-invoice-writes';

export type CollectSheet = 'approval' | 'record' | 'paylink';
const SHEETS: readonly CollectSheet[] = ['approval', 'record', 'paylink'];

/** Dev-only `?sheet=approval|record|paylink` opens a sheet on load (screenshot aid). */
export function devCollectSheet(): CollectSheet | null {
  if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return null;
  const s = new URLSearchParams(window.location.search).get('sheet');
  return SHEETS.find((x) => x === s) ?? null;
}

/**
 * "Customer approval" (draft, ≥ 1 line, finalize or sign allowed), "Record
 * payment" (open, balance > 0) and "Send pay link", each opening its bottom
 * sheet. Disabled while the server still holds a write (approval also while a
 * line or other non-approval intent is unknown); a helper sees nothing. The
 * page owns which sheet is open, so its banner can open Customer approval.
 * The sheets stay mounted while their button shows, so a held signature or an
 * unanswered payment survives a close and reopen.
 */
export function InvoiceCollectButtons({
  api,
  invoice,
  jobId,
  unknownKinds,
  sheet,
  onSheet,
  onNotice,
}: {
  readonly api: InvoicePageApi;
  readonly invoice: TechInvoice;
  readonly jobId: string;
  readonly unknownKinds: readonly IntentKind[];
  readonly sheet: CollectSheet | null;
  readonly onSheet: (s: CollectSheet | null) => void;
  /** The payment-success line, shown by the page (a full payment moves the
   * invoice to history, unmounting this); null clears it. */
  readonly onNotice: (text: string | null) => void;
}) {
  const { view } = api;
  if (!view.isLead) return null;
  const can = (a: (typeof view.allowed)[number]) => view.allowed.includes(a);
  const showApproval = invoice.state === 'draft' && invoice.lines.length > 0 && (can('finalize') || can('sign'));
  const showRecord = invoice.state === 'open' && invoice.balanceCents > 0 && can('record_payment');
  const showPayLink = can('pay_link');
  const close = () => onSheet(null);
  const openSheet = (s: CollectSheet) => {
    onNotice(null);
    onSheet(s);
  };
  if (!showApproval && !showRecord && !showPayLink) return null;
  const disabled = view.pendingWrite;

  return (
    <div className="space-y-2">
      {showApproval && (
        <>
          <Button className="h-12 w-full rounded-xl text-[16px]" disabled={disabled || approvalBlocked(unknownKinds)} onClick={() => openSheet('approval')}>
            Customer approval
          </Button>
          <ApprovalSheet
            open={sheet === 'approval'}
            onClose={close}
            onApproved={() => onSheet('record')}
            api={api}
            invoice={invoice}
            jobId={jobId}
          />
        </>
      )}
      {showRecord && (
        <>
          <Button className="h-12 w-full rounded-xl text-[16px]" disabled={disabled} onClick={() => openSheet('record')}>
            Record payment
          </Button>
          <RecordPaymentSheet
            open={sheet === 'record'}
            onClose={close}
            onRecorded={onNotice}
            api={api}
            invoice={invoice}
            jobId={jobId}
            paymentUnknown={unknownKinds.includes('payment')}
          />
        </>
      )}
      {showPayLink && (
        <>
          <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={disabled} onClick={() => openSheet('paylink')}>
            Send pay link
          </Button>
          <PayLinkSheet open={sheet === 'paylink'} onClose={close} api={api} invoice={invoice} jobId={jobId} />
        </>
      )}
    </div>
  );
}
