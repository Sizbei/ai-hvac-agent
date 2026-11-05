'use client';

import { CHECK_NUMBER_COPY, isValidCheckNumber } from '@/lib/payments/check-number';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatCentsExact, parseDollarsToCents } from '@/lib/admin/money-format';
import { mintKey } from '@/lib/http/idempotency-codes';
import {
  CARD_PAYMENTS_OFF_COPY,
  RECORD_PAYMENT_METHODS,
  RECORD_PAYMENT_NETWORK_COPY,
  centsToInputDollars,
  overBalanceCopy,
  buildRecordPaymentBody,
  recordPaymentErrorCopy,
  shouldReloadAfterRecord,
  shouldRemintToken,
  type RecordMethod,
} from '@/lib/admin/invoice-payment-copy';

/**
 * Office "Record payment" form (cash / check / other — no card in M3b). The
 * client token is minted when the form mounts (opens) and replaced after a
 * success or an ID_CONFLICT; the server derives the payment id from it, so a
 * double click or a browser retry records once. A network error or an
 * ID_CONFLICT means the payment may already have landed, so the parent reloads
 * the invoice before the message shows.
 */
export function RecordPaymentCard({
  invoiceId,
  balanceCents,
  receiptNotice,
  cardPaymentsEnabled,
  onRecorded,
  onReload,
}: {
  readonly invoiceId: string;
  /** Pre-fills the amount ("paid in full" is the common case) and bounds it. */
  readonly balanceCents: number;
  /** Said before recording when a receipt text will go out (M3b, by design). */
  readonly receiptNotice: string | null;
  readonly cardPaymentsEnabled: boolean;
  readonly onRecorded: () => void;
  /** Refetch the invoice (payments list) without closing the form. */
  readonly onReload: () => void;
}) {
  const [clientToken, setClientToken] = useState(() => mintKey());
  const [method, setMethod] = useState<RecordMethod>('cash');
  const [checkNumber, setCheckNumber] = useState('');
  const [amount, setAmount] = useState(() => centsToInputDollars(balanceCents));
  const cardRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // The card mounts below the invoice document: bring it into view and put
  // the cursor in the amount so the office doesn't hunt for the form.
  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    amountRef.current?.focus({ preventScroll: true });
  }, []);
  const [isDeposit, setIsDeposit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecord = useCallback(async (): Promise<void> => {
    const amountCents = parseDollarsToCents(amount);
    if (amountCents < 1) {
      setError('Enter an amount greater than zero.');
      return;
    }
    const over = overBalanceCopy(amountCents, balanceCents, formatCentsExact);
    if (over) {
      setError(over);
      return;
    }
    if (method === 'check' && checkNumber.trim().length > 0 && !isValidCheckNumber(checkNumber)) {
      setError(CHECK_NUMBER_COPY);
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildRecordPaymentBody({ clientToken, method, amountCents, checkNumber, isDeposit }),
        ),
      });
      const body = (await res.json().catch(() => ({ success: false }))) as {
        success: boolean;
        error?: { code?: string };
      };
      const ok = res.ok && body.success;
      if (shouldRemintToken(ok, body.error?.code)) setClientToken(mintKey());
      if (ok) {
        setAmount('');
        setCheckNumber('');
        setIsDeposit(false);
        onRecorded();
      } else {
        if (shouldReloadAfterRecord(body.error?.code)) onReload();
        setError(recordPaymentErrorCopy(body.error?.code));
      }
    } catch {
      if (shouldReloadAfterRecord(null)) onReload();
      setError(RECORD_PAYMENT_NETWORK_COPY);
    } finally {
      setIsSaving(false);
    }
  }, [invoiceId, balanceCents, clientToken, method, amount, checkNumber, isDeposit, onRecorded, onReload]);

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <CardTitle className="text-base">Record payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!cardPaymentsEnabled && (
          <p className="text-xs text-muted-foreground">{CARD_PAYMENTS_OFF_COPY}</p>
        )}
        <SegmentedControl
          aria-label="Payment method"
          options={RECORD_PAYMENT_METHODS}
          value={method}
          onChange={setMethod}
        />
        <div className="flex flex-wrap items-center gap-3">
          {method === 'check' && (
            <Input
              aria-label="Check number"
              placeholder="Check number"
              maxLength={32}
              value={checkNumber}
              onChange={(e) => setCheckNumber(e.target.value)}
              className="w-40"
            />
          )}
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              $
            </span>
            <Input
              ref={amountRef}
              aria-label="Payment amount in dollars"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-40 pl-6"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={isDeposit}
              onChange={(e) => setIsDeposit(e.target.checked)}
            />
            Deposit
          </label>
          <Button size="sm" disabled={isSaving || !amount} onClick={() => void handleRecord()}>
            {isSaving ? 'Recording…' : 'Record'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Balance due {formatCentsExact(balanceCents)}.
          {receiptNotice ? ` ${receiptNotice}` : ''}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
