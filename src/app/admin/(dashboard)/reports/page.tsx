'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  DollarSign,
  Wallet,
  Target,
  FileText,
  Receipt,
  Undo2,
  Loader2,
} from 'lucide-react';
import {
  useReports,
  type LeadSourceRow,
  type LocationBreakdownRow,
  type TechnicianScorecardRow,
} from '@/hooks/use-reports';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { StatCard } from '@/components/admin/ui/stat-card';
import { SectionCard } from '@/components/admin/ui/section-card';
import { DataTableShell } from '@/components/admin/ui/data-table-shell';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { BarChart2, MapPin, Users } from 'lucide-react';

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 365 days', days: 365 },
] as const;

export default function ReportsPage() {
  useEffect(() => { document.title = 'Reports · Spears Admin'; }, []);
  const [days, setDays] = useState<number>(30);

  // Recompute the range only when the preset changes (a fresh Date each render
  // would refetch on every render via the hook's from/to dependency).
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const {
    report,
    leadSourceBreakdown,
    locationBreakdown,
    technicianScorecards,
    isLoading,
    isRevalidating,
    error,
  } = useReports(range);

  return (
    <PageShell>
      <PageHeader
        title="Reports"
        subtitle="Revenue collected, outstanding balances, and estimate close rate."
        actions={
          <div className="flex gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.days}
                variant={days === preset.days ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDays(preset.days)}
              >
                {days === preset.days && isRevalidating && (
                  <Loader2 className="mr-1.5 size-3 animate-spin" aria-hidden="true" />
                )}
                {preset.label}
              </Button>
            ))}
          </div>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Primary KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Net revenue (period)"
          value={report ? formatCentsExact(report.netCollectedCents) : '—'}
          sublabel={
            report
              ? report.syncedCollectedCents > 0
                ? `${formatCentsExact(report.grossCollectedCents)} native − ${formatCentsExact(report.refundedCents)} refunded · +${formatCentsExact(report.syncedCollectedCents)} synced`
                : `${formatCentsExact(report.grossCollectedCents)} collected − ${formatCentsExact(report.refundedCents)} refunded`
              : undefined
          }
          icon={DollarSign}
          intent="success"
          loading={isLoading}
        />
        <StatCard
          label="Outstanding AR"
          value={report ? formatCentsExact(report.outstandingArCents) : '—'}
          sublabel={
            report && report.syncedArCents > 0
              ? `${formatCentsExact(report.nativeArCents)} native · ${formatCentsExact(report.syncedArCents)} synced`
              : 'Balance on open invoices'
          }
          icon={Wallet}
          intent="warning"
          loading={isLoading}
        />
        <StatCard
          label="Estimate close rate"
          value={report ? `${report.closeRatePct}%` : '—'}
          sublabel={
            report
              ? `${report.estimatesSold} sold of ${report.estimatesOpen + report.estimatesSold + report.estimatesExpired} decided`
              : undefined
          }
          icon={Target}
          intent="info"
          loading={isLoading}
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Estimates created"
          value={report ? String(report.estimatesCreated) : '—'}
          icon={FileText}
          intent="neutral"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          label="Estimates sold"
          value={report ? String(report.estimatesSold) : '—'}
          icon={Target}
          intent="info"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          label="Invoices paid"
          value={report ? `${report.invoicesPaid} / ${report.invoicesCreated}` : '—'}
          icon={Receipt}
          intent="success"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          label="Refunded (period)"
          value={report ? formatCentsExact(report.refundedCents) : '—'}
          icon={Undo2}
          intent="danger"
          size="sm"
          loading={isLoading}
        />
      </div>

      {/* Lead source ROI */}
      <LeadSourceTable rows={leadSourceBreakdown} isLoading={isLoading} />

      {/* By location */}
      <LocationTable rows={locationBreakdown} isLoading={isLoading} />

      {/* Technician scorecards */}
      <TechnicianTable rows={technicianScorecards} isLoading={isLoading} />
    </PageShell>
  );
}

/** A null metric renders an em dash, never a misleading 0. */
const EMPTY = '—';

function formatRating(rating: number | null): string {
  return rating == null ? EMPTY : `${rating.toFixed(1)}/5`;
}

function formatHours(hours: number | null): string {
  return hours == null ? EMPTY : `${hours.toFixed(1)}h`;
}

const LEAD_SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  facebook: 'Facebook',
  yelp: 'Yelp',
  referral: 'Referral',
  repeat_customer: 'Repeat customer',
  website: 'Website',
  direct_mail: 'Direct mail',
  other: 'Other',
  unknown: 'Unknown',
};

function leadSourceLabel(source: string): string {
  return LEAD_SOURCE_LABELS[source] ?? source;
}

interface LeadSourceTableProps {
  readonly rows: LeadSourceRow[];
  readonly isLoading: boolean;
}

function LeadSourceTable({ rows, isLoading }: LeadSourceTableProps) {
  // Sort by revenue desc; revenue lives in cents so a plain numeric sort is fine.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.revenueCents - a.revenueCents),
    [rows],
  );

  return (
    <SectionCard
      title="Lead source ROI"
      action={
        <p className="text-xs text-muted-foreground">
          Revenue and close rate by where each lead came from.
        </p>
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <DataTableShell
          columns={[
            { key: 'source', header: 'Source', cell: (row) => <span className="font-medium">{leadSourceLabel(row.source)}</span> },
            { key: 'leads', header: 'Leads', cell: (row) => <span className="tabular-nums">{row.leads}</span>, className: 'text-right' },
            { key: 'booked', header: 'Booked', cell: (row) => <span className="tabular-nums">{row.booked}</span>, className: 'text-right' },
            { key: 'closeRate', header: 'Close rate', cell: (row) => <span className="tabular-nums">{row.closeRatePct}%</span>, className: 'text-right' },
            { key: 'revenue', header: 'Revenue', cell: (row) => <span className="font-medium tabular-nums">{formatCentsExact(row.revenueCents)}</span>, className: 'text-right' },
          ]}
          rows={sorted}
          getRowKey={(row) => row.source}
          className="border-0 shadow-none"
          emptyState={<EmptyState icon={BarChart2} title="No lead data" description="No leads recorded in this period." className="py-8" />}
        />
      )}
    </SectionCard>
  );
}

interface LocationTableProps {
  readonly rows: LocationBreakdownRow[];
  readonly isLoading: boolean;
}

function LocationTable({ rows, isLoading }: LocationTableProps) {
  // Server already sorts by revenue desc; copy before sort to stay immutable.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.revenueCents - a.revenueCents),
    [rows],
  );

  return (
    <SectionCard
      title="By location"
      action={
        <p className="text-xs text-muted-foreground">
          Jobs, revenue, and rating rolled up by service location.
        </p>
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <DataTableShell
          columns={[
            { key: 'location', header: 'Location', cell: (row) => <span className="font-medium">{row.label}</span> },
            { key: 'jobs', header: 'Jobs', cell: (row) => <span className="tabular-nums">{row.jobs}</span>, className: 'text-right' },
            { key: 'avgRating', header: 'Avg rating', cell: (row) => <span className="tabular-nums">{formatRating(row.avgRating)}</span>, className: 'text-right' },
            { key: 'revenue', header: 'Revenue', cell: (row) => <span className="font-medium tabular-nums">{formatCentsExact(row.revenueCents)}</span>, className: 'text-right' },
          ]}
          rows={sorted}
          getRowKey={(row) => row.locationId}
          className="border-0 shadow-none"
          emptyState={<EmptyState icon={MapPin} title="No location data" description="No requests in this period." className="py-8" />}
        />
      )}
    </SectionCard>
  );
}

interface TechnicianTableProps {
  readonly rows: TechnicianScorecardRow[];
  readonly isLoading: boolean;
}

function TechnicianTable({ rows, isLoading }: TechnicianTableProps) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.revenueCents - a.revenueCents),
    [rows],
  );

  return (
    <SectionCard
      title="Technician scorecards"
      action={
        <p className="text-xs text-muted-foreground">
          Jobs, revenue, labor, and rating per technician. A dash means the data wasn&apos;t captured for that metric.
        </p>
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <DataTableShell
          columns={[
            { key: 'name', header: 'Technician', cell: (row) => <span className="font-medium">{row.name}</span> },
            { key: 'completed', header: 'Completed', cell: (row) => <span className="tabular-nums">{row.jobsCompleted} / {row.jobsAssigned}</span>, className: 'text-right' },
            { key: 'labor', header: 'Labor', cell: (row) => <span className="tabular-nums">{formatHours(row.laborHours)}</span>, className: 'text-right' },
            { key: 'avgRating', header: 'Avg rating', cell: (row) => <span className="tabular-nums">{formatRating(row.avgRating)}</span>, className: 'text-right' },
            { key: 'revenue', header: 'Revenue', cell: (row) => <span className="font-medium tabular-nums">{formatCentsExact(row.revenueCents)}</span>, className: 'text-right' },
          ]}
          rows={sorted}
          getRowKey={(row) => row.technicianId ?? 'unassigned'}
          className="border-0 shadow-none"
          emptyState={<EmptyState icon={Users} title="No scorecard data" description="No technicians with completed requests in this period." className="py-8" />}
        />
      )}
    </SectionCard>
  );
}
