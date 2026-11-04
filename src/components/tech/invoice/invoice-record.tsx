'use client';

import { useRef, useState } from 'react';
import { formatCentsExact } from '@/lib/admin/money-format';
import { paymentLabel, signatureCopy } from '@/lib/tech/invoice-page-copy';
import type { TechInvoicePayment, TechInvoiceSignature } from '@/lib/tech/invoice-view';

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The invoice's signature (its snapshot once open/paid). The signed URL expires
 * after 15 minutes, so a failed image load re-fetches the GET (`onImageError`)
 * — at most ONCE per `signedAt`: every GET mints a new URL, so a missing object
 * or a 403 would otherwise loop. A second failure shows "Signature unavailable".
 */
export function InvoiceSignature({
  signature,
  onImageError,
}: {
  readonly signature: TechInvoiceSignature;
  readonly onImageError: () => void;
}) {
  const refetchedFor = useRef<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const sigKey = signature.signedAt ?? '';
  const failed = failedFor === sigKey;
  const copy = failed ? signatureCopy('unavailable') : signatureCopy(signature.state);
  function imageFailed(): void {
    if (refetchedFor.current === sigKey) {
      setFailedFor(sigKey);
      return;
    }
    refetchedFor.current = sigKey;
    onImageError();
  }
  return (
    <section aria-labelledby="sig-title" className="space-y-2 border-t pt-3">
      <h3 id="sig-title" className="text-[13px] font-semibold text-muted-foreground">Signature</h3>
      {signature.state === 'present' && signature.url && !failed ? (
        <div className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL */}
          <img
            src={signature.url}
            alt={signature.signatureName ? `Signature of ${signature.signatureName}` : 'Customer signature'}
            className="h-24 w-full rounded-md border border-border bg-white object-contain"
            onError={imageFailed}
          />
          <p className="text-[15px]">
            {signature.signatureName ?? 'Customer'}
            {signature.signedAt && <span className="text-muted-foreground"> · {formatWhen(signature.signedAt)}</span>}
          </p>
        </div>
      ) : (
        <p className="text-[15px] text-muted-foreground">
          {copy ?? 'Signature unavailable'}
          {signature.state === 'estimate' && signature.signedAt ? ` · ${formatWhen(signature.signedAt)}` : ''}
        </p>
      )}
    </section>
  );
}

export function InvoicePayments({ payments }: { readonly payments: readonly TechInvoicePayment[] }) {
  if (payments.length === 0) return null;
  return (
    <section aria-labelledby="pay-title" className="space-y-1 border-t pt-3">
      <h3 id="pay-title" className="text-[13px] font-semibold text-muted-foreground">Payments</h3>
      <ul className="divide-y divide-border">
        {payments.map((p) => (
          <li key={p.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-[15px]">
                {paymentLabel(p.method, p.checkNumber)}
                {p.status !== 'succeeded' && <span className="text-muted-foreground"> · {p.status}</span>}
              </p>
              {p.createdAt && <p className="text-[13px] text-muted-foreground">{formatWhen(p.createdAt)}</p>}
            </div>
            <span className="shrink-0 font-mono text-[15px] tabular-nums">{formatCentsExact(p.amountCents)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
