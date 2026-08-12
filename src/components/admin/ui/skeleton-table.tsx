import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface SkeletonTableProps {
  /** Number of placeholder rows to render. Defaults to 4. */
  readonly rows?: number;
  /** Number of columns. Drives header + cell count. Defaults to 4. */
  readonly cols?: number;
  readonly className?: string;
}

/**
 * Generic loading skeleton that mirrors a DataTableShell shape: a sunken
 * 32 px header band + `rows` rows of placeholder bars.
 *
 * Bars inherit the shared `Skeleton` breathe (opacity, never shimmer — a
 * travelling highlight reads as activity that isn't happening).
 *
 * Used across platform-console, fieldpulse-import, and any other table
 * surface that needs a skeleton while data loads.
 */
export function SkeletonTable({
  rows = 4,
  cols = 4,
  className,
}: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "overflow-x-auto rounded-lg border border-border-strong bg-surface",
        className,
      )}
    >
      <Table>
        <TableHeader className="bg-surface-sunken">
          <TableRow className="border-0 shadow-[inset_0_-1px_0_var(--border-strong)] hover:bg-transparent">
            {Array.from({ length: cols }, (_, i) => (
              <TableHead key={i} className="h-8">
                <Skeleton className="h-2.5 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, r) => (
            <TableRow key={r} className="hover:bg-transparent">
              {Array.from({ length: cols }, (_, c) => (
                <TableCell key={c}>
                  <Skeleton
                    className={cn("h-3.5", c === 0 ? "w-36" : "w-24")}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
