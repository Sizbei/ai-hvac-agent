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
import { Label } from '@/components/ui/label';

/** Local YYYY-MM-DD for an <input type="date"> default. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
      // Send the dates as full-day ISO bounds (inclusive end-of-day).
      const fromISO = new Date(`${from}T00:00:00.000Z`).toISOString();
      const toISO = new Date(`${to}T23:59:59.999Z`).toISOString();
      const url = `/api/admin/accounting/export?from=${encodeURIComponent(
        fromISO,
      )}&to=${encodeURIComponent(toISO)}&format=csv`;

      const res = await fetch(url);
      if (!res.ok) {
        let message = 'Could not generate the export.';
        try {
          const json = await res.json();
          message = json.error?.message ?? message;
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
          refunds, and labor cost for a date range. Amounts are in dollars.
          Import the file into QuickBooks (or any ledger) manually.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="accounting-from">From</Label>
            <input
              id="accounting-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="accounting-to">To</Label>
            <input
              id="accounting-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
      </CardContent>
    </Card>
  );
}
