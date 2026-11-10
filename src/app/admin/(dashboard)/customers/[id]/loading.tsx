import { PageShell } from "@/components/admin/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Instant frame for a customer detail page: title row, then stacked cards. */
export default function CustomerDetailLoading() {
  return (
    <PageShell>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-8 w-56" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-16 rounded-md" />
            <Skeleton className="h-9 w-9 rounded-md" />
          </div>
        </div>
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </PageShell>
  );
}
