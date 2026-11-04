'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { parseDollarsToCents } from '@/lib/admin/money-format';
import { mintKey } from '@/lib/http/idempotency-codes';
import {
  RECORD_PAYMENT_METHODS,
  buildRecordPaymentBody,
  recordPaymentErrorCopy,
  shouldRemintToken,
  type RecordMethod,
} from '@/lib/admin/invoice-payment-copy';

/**
 * Office "Record payment" form (cash / check / other — no card in M3b). The
 * client token is minted when the form mounts (opens) and replaced after a
 * success or an ID_CONFLICT; the server derives the payment id from it, so a
 * double click or a browser retry records once.
 */
export function RecordPaymentCard({
  invoiceId,
  onRecorded,
}: {
  readonly invoiceId: string;
  readonly onRecorded: () => void;
}) {
  const [clientToken, setClientToken] = useState(() => mintKey());
  const [method, setMethod] = useState<RecordMethod>('cash');
  const [checkNumber, setCheckNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [isDeposit, setIsDeposit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecord = useCallback(async (): Promise<void> => {
    const amountCents = parseDollarsToCents(amount);
    if (amountCents < 1) {
      setError('Enter an amount greater than zero.');
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
        setError(recordPaymentErrorCopy(body.error?.code));
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [invoiceId, clientToken, method, amount, checkNumber, isDeposit, onRecorded]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
