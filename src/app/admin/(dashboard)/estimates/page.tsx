'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, AlertCircle, FileText } from 'lucide-react';
import { useEstimates } from '@/hooks/use-estimates';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function EstimatesPage() {
  const { estimates, isLoading, error, refetch } = useEstimates();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Estimates</h1>
          <p className="text-sm text-muted-foreground">
            Good / better / best proposals with public e-sign approval.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New estimate
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : estimates.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <FileText className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            No estimates yet. Create one to send a customer a proposal.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Links</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {estimates.map((est) => (
                <tr key={est.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-3">{formatDate(est.createdAt)}</td>
                  <td className="px-4 py-3">
                    <EstimateStatusBadge status={est.status} />
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {formatCentsExact(est.totalCents)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {est.customerId && (
                      <Link
                        href={`/admin/customers/${est.customerId}`}
                        className="hover:underline"
                      >
                        Customer
                      </Link>
                    )}
                    {est.customerId && est.serviceRequestId && ' · '}
                    {est.serviceRequestId && (
                      <Link
                        href={`/admin/requests?request=${est.serviceRequestId}`}
                        className="hover:underline"
                      >
                        Request
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/estimates/${est.id}`}>
                      <Button variant="outline" size="sm">
                        View
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EstimateCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void refetch()}
      />
    </div>
  );
}
