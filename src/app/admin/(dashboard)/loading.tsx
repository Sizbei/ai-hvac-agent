import { PageShell } from "@/components/admin/ui/page-shell";
import { SkeletonTable } from "@/components/admin/ui/skeleton-table";
import { Skeleton } from "@/components/ui/skeleton";

/** Generic instant frame for every admin route without its own loading.tsx. */
export default function AdminLoading() {
  return (
    <PageShell>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
      <SkeletonTable rows={8} cols={5} />
    </PageShell>
  );
}
