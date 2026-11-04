'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { finalizeErrorCopy } from '@/lib/admin/invoice-payment-copy';

/**
 * Finalize a native draft (draft → open) so a draft a technician left behind
 * is never stranded. Two-click confirm: the first click arms, the second posts.
 */
export function FinalizeButton({
  invoiceId,
  onFinalized,
}: {
  readonly invoiceId: string;
  readonly onFinalized: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFinalize = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({ success: false }))) as {
        success: boolean;
        error?: { code?: string };
      };
      if (res.ok && body.success) {
        setArmed(false);
        onFinalized();
      } else {
        setError(finalizeErrorCopy(body.error?.code));
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [invoiceId, onFinalized]);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {armed ? (
        <>
          <Button size="sm" disabled={isSaving} onClick={() => void handleFinalize()}>
            {isSaving ? 'Finalizing…' : 'Confirm finalize'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isSaving}
            onClick={() => {
              setArmed(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setArmed(true)}>
          Finalize
        </Button>
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
