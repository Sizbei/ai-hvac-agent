import { StatTileSkeleton, TableSkeleton } from '@/components/admin/skeletons';

export default function InvoicesLoading() {
  return (
    <div className="space-y-6 p-6">
      {/* header */}
      <div className="h-7 w-24 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      {/* stat tiles — 4 tiles matching the SummaryBand / StatTileSkeleton row in invoices */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTileSkeleton />
        <StatTileSkeleton />
        <StatTileSkeleton />
        <StatTileSkeleton />
      </div>
      {/* filter tabs */}
      <div className="flex gap-2">
        <div className="h-9 w-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-16 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-16 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      {/* invoices table — 6 columns matching the real table */}
      <TableSkeleton rows={8} cols={6} />
    </div>
  );
}
