'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatCentsExact } from '@/lib/admin/money-format';
import { INTENTS_STORAGE_KEY, parseIntents } from '@/lib/tech/invoice-intent-persist';
import { inFlightPaymentBody } from '@/lib/tech/invoice-page-locks';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import { noteFor, type SheetNote } from '@/lib/tech/sheet-note';
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
import { NoteLine, TechSheet } from './tech-sheet';
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
  const [note, setNote] = useState<SheetNote | null>(null);
  const clearNote = () => setNote(null);
  // The body of the last send that has no definitive answer yet.
  const [lastBody, setLastBody] = useState<PaymentBody | null>(null);

  const stored = paymentUnknown && !lastBody ? storedPaymentBody(jobId) : null;
  const inFlight = inFlightPaymentBody({ busy, paymentUnknown, stored }, lastBody);
  const shownMethod = inFlight?.method ?? method;
  const shownAmount = inFlight ? dollars(inFlight.amountCents) : amount ?? dollars(invoice.balanceCents);
  const shownCheck = inFlight ? inFlight.checkNumber ?? '' : checkNumber;
  const labelCents = inFlight?.amountCents ?? parseAmountCents(shownAmount);

  function reset(): void {
    setAmount(null);
    setCheckNumber('');
    setNote(null);
  }

  async function record(): Promise<void> {
    if (busyRef.current) return;
    let body = inFlight;
    if (!body) {
      const v = validateRecordForm({ amount: shownAmount, balanceCents: invoice.balanceCents, method, checkNumber });
      if (!v.ok) {
        setNote({ text: v.error, error: true });
        return;
      }
      body = buildPaymentBody(invoice.id, method, v.amountCents, checkNumber);
    }
    busyRef.current = true;
    setBusy(true);
    setNote(null);
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
      // retry/pending: still unknown, keep the in-flight body for the same-key re-send.
      if (r.status !== 'retry' && r.status !== 'pending') setLastBody(null);
      setNote(noteFor(r, "Couldn't record the payment. Try again."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const readOnly = inFlight !== null;
  const locked = busy || api.view.pendingWrite;

  return (
    <TechSheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      busy={busy}
      title="Record payment"
      description={<>Balance due <span className="font-mono tabular-nums">{formatCentsExact(invoice.balanceCents)}</span></>}
    >
        <fieldset disabled={locked || readOnly} className="min-w-0 space-y-4 px-4">
          <SegmentedControl
            aria-label="Payment method"
            options={METHODS}
            value={shownMethod}
            onChange={(m) => { setMethod(m); clearNote(); }}
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
                aria-invalid={note?.error === true}
                onChange={(e) => { setAmount(e.target.value); clearNote(); }}
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
          <NoteLine note={note} />
          <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void record()}>
            {busy ? 'Recording…' : recordLabel(labelCents)}
          </Button>
        </div>
    </TechSheet>
  );
}
