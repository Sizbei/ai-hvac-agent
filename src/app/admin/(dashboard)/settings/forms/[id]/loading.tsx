import { PageShell } from "@/components/admin/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Instant frame for the narrow form builder. */
export default function FormBuilderLoading() {
  return (
    <PageShell narrow>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-40 w-full" />
    </PageShell>
  );
}
