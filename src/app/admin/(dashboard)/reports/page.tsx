'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  DollarSign,
  Wallet,
  Target,
  FileText,
  Receipt,
  Undo2,
} from 'lucide-react';
import {
  useReports,
  type LeadSourceRow,
  type LocationBreakdownRow,
  type TechnicianScorecardRow,
} from '@/hooks/use-reports';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatCentsExact } from '@/lib/admin/money-format';

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 365 days', days: 365 },
] as const;

export default function ReportsPage() {
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
    error,
  } = useReports(range);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Revenue collected, outstanding balances, and estimate close rate.
          </p>
        </div>
        <div className="flex gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.days}
              variant={days === preset.days ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDays(preset.days)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Primary KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
        <KpiCard
          label="Net revenue (period)"
          value={report ? formatCentsExact(report.netCollectedCents) : null}
          hint={
            report
              ? // Surface synced (FSM-mirrored) revenue separately so the two
                // sources are never read as one blended number.
                report.syncedCollectedCents > 0
                ? `${formatCentsExact(report.grossCollectedCents)} native − ${formatCentsExact(
                    report.refundedCents,
                  )} refunded · +${formatCentsExact(report.syncedCollectedCents)} synced`
                : `${formatCentsExact(report.grossCollectedCents)} collected − ${formatCentsExact(
                    report.refundedCents,
                  )} refunded`
              : undefined
          }
          icon={DollarSign}
          bgColor="bg-green-100 dark:bg-green-900/30"
          iconColor="text-green-600 dark:text-green-400"
          isLoading={isLoading}
        />
        <KpiCard
          label="Outstanding AR"
          value={report ? formatCentsExact(report.outstandingArCents) : null}
          hint={
            report && report.syncedArCents > 0
              ? `${formatCentsExact(report.nativeArCents)} native · ${formatCentsExact(
                  report.syncedArCents,
                )} synced`
              : "Balance on open invoices"
          }
          icon={Wallet}
          bgColor="bg-amber-100 dark:bg-amber-900/30"
          iconColor="text-amber-600 dark:text-amber-400"
          isLoading={isLoading}
        />
        <KpiCard
          label="Estimate close rate"
          value={report ? `${report.closeRatePct}%` : null}
          hint={
            report
              ? `${report.estimatesSold} sold of ${
                  report.estimatesOpen + report.estimatesSold + report.estimatesExpired
                } decided`
              : undefined
          }
          icon={Target}
          bgColor="bg-blue-100 dark:bg-blue-900/30"
          iconColor="text-blue-600 dark:text-blue-400"
          isLoading={isLoading}
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiCard
          label="Estimates created"
          value={report ? String(report.estimatesCreated) : null}
          icon={FileText}
          bgColor="bg-slate-100 dark:bg-slate-800/50"
          iconColor="text-slate-600 dark:text-slate-300"
          isLoading={isLoading}
        />
        <KpiCard
          label="Estimates sold"
          value={report ? String(report.estimatesSold) : null}
          icon={Target}
          bgColor="bg-blue-100 dark:bg-blue-900/30"
          iconColor="text-blue-600 dark:text-blue-400"
          isLoading={isLoading}
        />
        <KpiCard
          label="Invoices paid"
          value={report ? `${report.invoicesPaid} / ${report.invoicesCreated}` : null}
          icon={Receipt}
          bgColor="bg-green-100 dark:bg-green-900/30"
          iconColor="text-green-600 dark:text-green-400"
          isLoading={isLoading}
        />
        <KpiCard
          label="Refunded (period)"
          value={report ? formatCentsExact(report.refundedCents) : null}
          icon={Undo2}
          bgColor="bg-red-100 dark:bg-red-900/30"
          iconColor="text-red-600 dark:text-red-400"
          isLoading={isLoading}
        />
      </div>

      {/* Lead source ROI */}
      <LeadSourceTable rows={leadSourceBreakdown} isLoading={isLoading} />

      {/* By location */}
      <LocationTable rows={locationBreakdown} isLoading={isLoading} />

      {/* Technician scorecards */}
      <TechnicianTable rows={technicianScorecards} isLoading={isLoading} />
    </div>
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
    <Card className="p-4">
      <div className="mb-3">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Lead source ROI
        </h2>
        <p className="text-xs text-muted-foreground">
          Revenue and close rate by where each lead came from.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 text-left font-medium">Source</th>
                <th className="py-2 px-3 text-right font-medium">Leads</th>
                <th className="py-2 px-3 text-right font-medium">Booked</th>
                <th className="py-2 px-3 text-right font-medium">Close rate</th>
                <th className="py-2 pl-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.source}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="py-2 pr-3 font-medium">
                    {leadSourceLabel(row.source)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.leads}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.booked}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.closeRatePct}%
                  </td>
                  <td className="py-2 pl-3 text-right font-medium tabular-nums">
                    {formatCentsExact(row.revenueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
    <Card className="p-4">
      <div className="mb-3">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          By location
        </h2>
        <p className="text-xs text-muted-foreground">
          Jobs, revenue, and rating rolled up by service location.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No jobs in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 text-left font-medium">Location</th>
                <th className="py-2 px-3 text-right font-medium">Jobs</th>
                <th className="py-2 px-3 text-right font-medium">Avg rating</th>
                <th className="py-2 pl-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.locationId}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="py-2 pr-3 font-medium">{row.label}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.jobs}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {formatRating(row.avgRating)}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium tabular-nums">
                    {formatCentsExact(row.revenueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
    <Card className="p-4">
      <div className="mb-3">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Technician scorecards
        </h2>
        <p className="text-xs text-muted-foreground">
          Jobs, revenue, labor, and rating per technician. A dash means the data
          wasn&apos;t captured for that metric.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No assigned jobs in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 text-left font-medium">Technician</th>
                <th className="py-2 px-3 text-right font-medium">Completed</th>
                <th className="py-2 px-3 text-right font-medium">Labor</th>
                <th className="py-2 px-3 text-right font-medium">Avg rating</th>
                <th className="py-2 pl-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.technicianId}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="py-2 pr-3 font-medium">{row.name}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.jobsCompleted} / {row.jobsAssigned}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {formatHours(row.laborHours)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {formatRating(row.avgRating)}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium tabular-nums">
                    {formatCentsExact(row.revenueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface KpiCardProps {
  readonly label: string;
  readonly value: string | null;
  readonly hint?: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly bgColor: string;
  readonly iconColor: string;
  readonly isLoading: boolean;
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  bgColor,
  iconColor,
  isLoading,
}: KpiCardProps) {
  return (
    <Card className="p-4 transition-shadow duration-200 hover:shadow-md hover:ring-1 hover:ring-primary/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {isLoading || value === null ? (
            <Skeleton className="mt-2 h-9 w-24" />
          ) : (
            <p className="mt-1 font-heading text-3xl font-bold tracking-tight tabular-nums">
              {value}
            </p>
          )}
          {hint && !isLoading && value !== null && (
            <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
        <div className={`shrink-0 rounded-xl p-2.5 ${bgColor}`}>
          <Icon className={`h-5 w-5 ${iconColor}`} />
        </div>
      </div>
    </Card>
  );
}
