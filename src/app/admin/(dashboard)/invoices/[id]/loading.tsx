import { PageShell } from "@/components/admin/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/** Instant frame for an invoice detail page: header, main panel, side rail. */
export default function InvoiceDetailLoading() {
  return (
    <PageShell>
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_280px]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </PageShell>
  );
}
