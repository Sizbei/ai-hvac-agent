'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { READ_ONLY_PREVIEW } from '@/lib/admin/preview-view';

/** The viewer's local YYYY-MM-DD for an <input type="date"> default. */
function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Super-admin-only accounting (QuickBooks/CSV) export panel. The page renders
 * it only for a super_admin viewer (decided on the server); the export
 * endpoint (/api/admin/accounting/export) is itself super_admin-gated.
 * `readOnly` ("View as" preview) disables Download.
 */
export function AccountingExportPanel({ readOnly = false }: { readonly readOnly?: boolean }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return ymd(d);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    setError(null);
    setDownloaded(null);
    if (!from || !to) {
      setError('Pick both a start and end date.');
      return;
    }
    if (from > to) {
      setError('The start date must be on or before the end date.');
      return;
    }
    setDownloading(true);
    try {
      // Plain business days: the server covers them in the org's time zone.
      const url = `/api/admin/accounting/export?from=${encodeURIComponent(
        from,
      )}&to=${encodeURIComponent(to)}&format=csv`;

      const res = await fetch(url);
      if (!res.ok) {
        let message = 'Could not generate the export.';
        try {
          const json = await res.json();
          // Server copy only for a bad request (e.g. dates); never a 5xx text.
          if (res.status === 400) message = json.error?.message ?? message;
        } catch {
          // non-JSON error body — keep the default message.
        }
        setError(message);
        return;
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `accounting-export-${from}_to_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloaded(a.download);
    } catch {
      setError('Could not generate the export.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounting export</CardTitle>
        <CardDescription>
          Download a QuickBooks-compatible CSV journal of invoices, payments,
          refunds, and labor cost for a date range. Amounts are in dollars;
          refunds are negative; sales tax posts to Sales Tax Payable, not
          revenue. Dates are your business days in your time zone. Import only
          the rows marked Yes in the Import column — the others are already
          booked in FieldPulse or Housecall Pro.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="accounting-from">From</Label>
            <Input
              id="accounting-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="w-auto"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accounting-to">To</Label>
            <Input
              id="accounting-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="w-auto"
            />
          </div>
          <span title={readOnly ? READ_ONLY_PREVIEW : undefined}>
            <Button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading || readOnly}
            >
              {downloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Download CSV
            </Button>
          </span>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {downloaded && (
          <p role="status" className="text-sm text-success">
            Downloaded {downloaded}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
