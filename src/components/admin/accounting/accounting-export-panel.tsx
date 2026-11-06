'use client';

import { useEffect, useState } from 'react';
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

/** The viewer's local YYYY-MM-DD for an <input type="date"> default. */
function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Super-admin-only accounting (QuickBooks/CSV) export panel.
 *
 * The export endpoint (/api/admin/accounting/export) is itself super_admin-gated,
 * so the server is the authority for visibility. We probe it once WITHOUT a date
 * range: a non-super_admin gets 403 (gate runs before validation) and we render
 * nothing; a super_admin gets 400 VALIDATION_ERROR (authorized, just missing
 * params) and we show the panel. The probe never downloads a file.
 */
export function AccountingExportPanel() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return ymd(d);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/accounting/export');
        if (cancelled) return;
        // 401/403 => not authorized. Anything else (400 missing params, etc.)
        // means the caller passed the gate.
        setAuthorized(res.status !== 401 && res.status !== 403);
      } catch {
        if (!cancelled) setAuthorized(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authorized === null || authorized === false) return null;

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
          booked in FieldPulse or HCP.
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
          <Button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Download CSV
          </Button>
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
