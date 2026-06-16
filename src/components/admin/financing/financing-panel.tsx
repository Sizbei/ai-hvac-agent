'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Subordinate "Offer financing" affordance for an estimate or invoice.
 *
 * Renders ONLY the provider-returned status + a copyable apply link — never an
 * APR / monthly payment / Reg-Z term (the lender owns terms). If an application
 * already exists, its status/link is shown instead of the offer button.
 */
interface FinancingApplication {
  readonly id: string;
  readonly status: string;
  readonly applyUrl: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Application sent',
  approved: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
};

export function FinancingPanel({
  invoiceId,
  estimateId,
  requestedAmountCents,
}: {
  readonly invoiceId?: string;
  readonly estimateId?: string;
  readonly requestedAmountCents: number;
}) {
  const [application, setApplication] = useState<FinancingApplication | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOffering, setIsOffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const query = invoiceId
    ? `invoiceId=${invoiceId}`
    : `estimateId=${estimateId}`;

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/financing?${query}`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setApplication(body.data.applications[0] ?? null);
      }
    } catch {
      // Non-fatal: the offer button stays available.
    } finally {
      setIsLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleOffer = useCallback(async (): Promise<void> => {
    setIsOffering(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/financing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(invoiceId ? { invoiceId } : { estimateId }),
          requestedAmountCents,
        }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setApplication(body.data.application);
      } else {
        setError(body.error?.message ?? 'Failed to offer financing');
      }
    } catch {
      setError('Could not connect to server.');
    } finally {
      setIsOffering(false);
    }
  }, [invoiceId, estimateId, requestedAmountCents]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (!application?.applyUrl) return;
    try {
      await navigator.clipboard.writeText(application.applyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the link stays visible/selectable below.
    }
  }, [application?.applyUrl]);

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Financing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {application ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Status</span>
              <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">
                {STATUS_LABEL[application.status] ?? application.status}
              </span>
            </div>
            {application.applyUrl && (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={application.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-primary hover:underline"
                >
                  {application.applyUrl}
                </a>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Send the customer a prequalification link. Terms are set by the
              lender on their secure page.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={isOffering}
              onClick={handleOffer}
            >
              {isOffering ? 'Sending…' : 'Offer financing'}
            </Button>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
