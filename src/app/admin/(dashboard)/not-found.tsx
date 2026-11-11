import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageShell } from "@/components/admin/ui/page-shell";
import { ErrorState } from "@/components/admin/ui/error-state";

/** In-shell 404 for notFound() calls and switched-off pages. */
export default function AdminNotFound() {
  return (
    <PageShell narrow>
      <ErrorState
        icon={FileQuestion}
        title="We couldn’t find that page"
        description="It may have moved, or the link may be out of date."
        action={<Link href="/admin" className={buttonVariants()}>Go to dashboard</Link>}
      />
    </PageShell>
  );
}
