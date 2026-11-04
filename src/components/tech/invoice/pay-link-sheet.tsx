'use client';

import { useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import { postJson } from './post-json';
import type { InvoicePageApi } from './use-invoice-writes';

const SENT_CLOSE_MS = 1500;

/**
 * "Send pay link" (spec §7.4): one confirmation, "Send". COOLDOWN and the
 * stored SEND_FAILED show the server's copy; success shows "Link sent." and
 * closes the sheet.
 */
export function PayLinkSheet({
  open,
  onClose,
  api,
  invoice,
  jobId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly api: InvoicePageApi;
  readonly invoice: TechInvoice;
  readonly jobId: string;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function close(): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMessage(null);
    setSent(false);
    onClose();
  }

  async function send(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    const body = { invoiceId: invoice.id };
    try {
      const r = await api.write({ kind: 'pay_link' }, (key) => postJson(`/api/tech/jobs/${jobId}/invoice/pay-link`, body, key), body);
      if (r.status === 'done') {
        setSent(true);
        setMessage({ text: 'Link sent.', error: false });
        timer.current = setTimeout(close, SENT_CLOSE_MS);
        return;
      }
      if (r.message) setMessage({ text: r.message, error: r.status !== 'pending' && r.status !== 'skipped' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o && !busy) close(); }}>
      <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[17px]">Send pay link</SheetTitle>
          <SheetDescription className="text-[15px]">Text the invoice link to the customer?</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4">
          {message && (
            <p role={message.error ? 'alert' : 'status'} className={`text-[15px] ${message.error ? 'text-danger-strong' : sent ? 'text-success-strong' : 'text-muted-foreground'}`}>
              {message.text}
            </p>
          )}
          <Button className="h-12 w-full rounded-xl text-[16px]" disabled={busy || sent || api.view.pendingWrite} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
