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
 * Generic loading skeleton that mirrors a DataTableShell shape:
 * `cols` greyed-out header cells + `rows` rows of placeholder cells.
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
      className={cn("overflow-x-auto rounded-lg border", className)}
    >
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: cols }, (_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-3 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, r) => (
            <TableRow key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <TableCell key={c}>
                  <Skeleton
                    className={cn("h-4", c === 0 ? "w-36" : "w-24")}
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
