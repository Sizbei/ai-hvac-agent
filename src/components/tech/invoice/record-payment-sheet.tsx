'use client';

import { useRef, useState } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatCentsExact } from '@/lib/admin/money-format';
import { INTENTS_STORAGE_KEY, parseIntents } from '@/lib/tech/invoice-intent-persist';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import {
  buildPaymentBody,
  CHECK_NUMBER_MAX,
  inFlightCopy,
  LAST_METHOD_KEY,
  parseAmountCents,
  parseStoredMethod,
  paymentSuccessCopy,
  recordLabel,
  validateRecordForm,
  type PaymentBody,
  type TechPaymentMethod,
} from '@/lib/tech/record-payment-form';
import { postJson } from './post-json';
import type { InvoicePageApi } from './use-invoice-writes';

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
] as const;

function readMethod(): TechPaymentMethod {
  try {
    return parseStoredMethod(window.localStorage.getItem(LAST_METHOD_KEY));
  } catch {
    return 'cash';
  }
}

function rememberMethod(m: TechPaymentMethod): void {
  try {
    window.localStorage.setItem(LAST_METHOD_KEY, m);
  } catch {
    /* storage unavailable: the default stays cash */
  }
}

/** A payment intent persisted by the key hook (after a reload). */
function storedPaymentBody(jobId: string): PaymentBody | null {
  try {
    const s = parseIntents(window.sessionStorage.getItem(INTENTS_STORAGE_KEY(jobId))).payment;
    return s && s.phase !== 'idle' ? (s.body as PaymentBody) : null;
  } catch {
    return null;
  }
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * "Record payment" (spec §7.4): Cash | Check (Card absent), the last method
 * remembered, amount defaulting to the balance with the max checked inline
 * BEFORE posting, an optional check number, "Record $x". While the payment
 * intent is in flight or unknown the inputs are read-only and show the
 * in-flight body; "Record $x" then re-sends that body with the same key.
 */
export function RecordPaymentSheet({
  open,
  onClose,
  onRecorded,
  api,
  invoice,
  jobId,
  paymentUnknown,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRecorded: (message: string) => void;
  readonly api: InvoicePageApi;
  readonly invoice: TechInvoice;
  readonly jobId: string;
  readonly paymentUnknown: boolean;
}) {
  const [method, setMethod] = useState<TechPaymentMethod>(readMethod);
  const [amount, setAmount] = useState<string | null>(null); // null = the balance
  const [checkNumber, setCheckNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The body of the last send that has no definitive answer yet.
  const [lastBody, setLastBody] = useState<PaymentBody | null>(null);

  const inFlight = busy || paymentUnknown ? lastBody ?? (paymentUnknown ? storedPaymentBody(jobId) : null) : null;
  const shownMethod = inFlight?.method ?? method;
  const shownAmount = inFlight ? dollars(inFlight.amountCents) : amount ?? dollars(invoice.balanceCents);
  const shownCheck = inFlight ? inFlight.checkNumber ?? '' : checkNumber;
  const labelCents = inFlight?.amountCents ?? parseAmountCents(shownAmount);

  function reset(): void {
    setAmount(null);
    setCheckNumber('');
    setError(null);
    setStatus(null);
  }

  async function record(): Promise<void> {
    if (busyRef.current) return;
    let body = inFlight;
    if (!body) {
      const v = validateRecordForm({ amount: shownAmount, balanceCents: invoice.balanceCents, method, checkNumber });
      if (!v.ok) {
        setError(v.error);
        return;
      }
      body = buildPaymentBody(invoice.id, method, v.amountCents, checkNumber);
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    setLastBody(body);
    rememberMethod(body.method);
    const sent = body;
    try {
      const r = await api.write(
        { kind: 'payment', amountCents: sent.amountCents, method: sent.method },
        (key) => postJson(`/api/tech/jobs/${jobId}/invoice/payments`, sent, key),
        sent,
      );
      if (r.status === 'done' || r.status === 'dropped') {
        setLastBody(null);
        reset();
        onClose();
        onRecorded(paymentSuccessCopy(api.view.customerHasPhone));
        return;
      }
      if (r.status === 'pending' || r.status === 'skipped') {
        if (r.status === 'skipped') setLastBody(null);
        setStatus(r.message);
        return;
      }
      if (r.status !== 'retry') setLastBody(null);
      setError(r.message ?? "Couldn't record the payment. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const readOnly = inFlight !== null;
  const locked = busy || api.view.pendingWrite;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o && !busy) { reset(); onClose(); } }}>
      <SheetContent side="bottom" className="max-h-[92dvh] gap-3 overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[17px]">Record payment</SheetTitle>
          <SheetDescription className="text-[15px]">
            Balance due <span className="font-mono tabular-nums">{formatCentsExact(invoice.balanceCents)}</span>
          </SheetDescription>
        </SheetHeader>
        <fieldset disabled={locked || readOnly} className="min-w-0 space-y-4 px-4">
          <SegmentedControl
            aria-label="Payment method"
            options={METHODS}
            value={shownMethod}
            onChange={(m) => { setMethod(m); setError(null); }}
            className="h-11 w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:text-[15px]"
          />
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">Amount</span>
            <span className="relative block">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[16px] text-muted-foreground">$</span>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={shownAmount}
                readOnly={readOnly}
                aria-invalid={error !== null}
                onChange={(e) => { setAmount(e.target.value); setError(null); }}
                className="h-11 rounded-xl pl-7 font-mono text-[16px] tabular-nums"
              />
            </span>
          </label>
          {shownMethod === 'check' && (
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-muted-foreground">Check number (optional)</span>
              <Input
                inputMode="numeric"
                autoComplete="off"
                maxLength={CHECK_NUMBER_MAX}
                value={shownCheck}
                readOnly={readOnly}
                onChange={(e) => setCheckNumber(e.target.value)}
                className="h-11 rounded-xl font-mono text-[16px] tabular-nums"
              />
            </label>
          )}
        </fieldset>
        <div className="space-y-3 px-4">
          {inFlight && <p role="status" className="text-[15px] text-muted-foreground">{inFlightCopy(inFlight.amountCents)}</p>}
          {status && <p role="status" className="text-[15px] text-muted-foreground">{status}</p>}
          {error && <p role="alert" className="text-[15px] text-danger-strong">{error}</p>}
          <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void record()}>
            {busy ? 'Recording…' : recordLabel(labelCents)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
