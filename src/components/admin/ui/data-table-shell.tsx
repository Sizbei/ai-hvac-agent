import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

// ── Column definition ──────────────────────────────────────────────────────────

export interface DataTableColumn<TRow = unknown> {
  /** Column key — must be unique within the table. */
  readonly key: string
  /**
   * Header label. Must be sentence case; no uppercase/tracking enforced by
   * consumers but this shell renders it as-is (no transform).
   */
  readonly header: string
  /** Render function for the cell content. */
  readonly cell: (row: TRow) => React.ReactNode
  /** className applied to both the `<th>` and all `<td>` in this column. */
  readonly className?: string
}

// ── DataTableShell props ───────────────────────────────────────────────────────

interface DataTableShellProps<TRow = unknown> {
  /** Column definitions — header + cell renderer. */
  readonly columns: ReadonlyArray<DataTableColumn<TRow>>
  /** Row data. */
  readonly rows: ReadonlyArray<TRow>
  /** Unique key extractor for React reconciliation. */
  readonly getRowKey: (row: TRow) => string
  /** Optional toolbar rendered above the table (filters, search, actions). */
  readonly toolbar?: React.ReactNode
  /** Optional footer rendered below the table (typically a `<Pager>`). */
  readonly footer?: React.ReactNode
  /**
   * Loading state: shows a skeleton matching the column count.
   * When `rows` is non-empty and `isLoading` is true the existing rows dim
   * (stale-while-revalidate pattern) instead of flashing a skeleton.
   */
  readonly isLoading?: boolean
  /** Number of skeleton rows to render when loading with no rows. */
  readonly skeletonRows?: number
  /**
   * Empty state slot — rendered when rows is empty and not loading.
   * Pass an `<EmptyState>` component.
   */
  readonly emptyState?: React.ReactNode
  /**
   * Make the header sticky within the scrollable overflow container.
   * Use when tables are long enough that losing the header while scrolling
   * hurts usability.
   */
  readonly stickyHeader?: boolean
  /** Row click handler. When provided, rows get `cursor-pointer`. */
  readonly onRowClick?: (row: TRow) => void
  readonly className?: string
}

/**
 * DataTableShell — card-wrapped, overflow-safe table shell.
 *
 * Enforces one column-header treatment: sentence case, 11–12 px,
 * `text-muted-foreground`, no uppercase/tracking. Absorbs the card chrome,
 * overflow-x scrolling, and empty/loading states so consumers only supply
 * columns + rows + optional toolbar/footer.
 *
 * Replaces ~200 lines of hand-rolled table chrome across requests, staff,
 * pricebook, inventory, estimates, customers, reports, and audit-log.
 */
export function DataTableShell<TRow = unknown>({
  columns,
  rows,
  getRowKey,
  toolbar,
  footer,
  isLoading = false,
  skeletonRows = 5,
  emptyState,
  stickyHeader = false,
  onRowClick,
  className,
}: DataTableShellProps<TRow>) {
  const showSkeleton = isLoading && rows.length === 0
  const showDimmed = isLoading && rows.length > 0
  const showEmpty = !isLoading && rows.length === 0

  return (
    <Card className={cn("gap-0 p-0", className)}>
      {/* Toolbar (filters, search, actions) */}
      {toolbar && (
        <div className="border-b px-4 py-3">
          {toolbar}
        </div>
      )}

      {/* Scrollable table region */}
      <div className="overflow-x-auto" aria-busy={isLoading}>
        <div
          className={cn(
            "transition-opacity duration-150",
            showDimmed && "pointer-events-none opacity-50",
          )}
        >
          <Table>
            <TableHeader
              className={cn(stickyHeader && "sticky top-0 z-10 bg-card")}
            >
              <TableRow className="hover:bg-transparent">
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    scope="col"
                    className={cn(
                      // Enforced header style: ~11–12px, muted, no uppercase/tracking
                      "h-9 text-[11px] font-medium text-muted-foreground",
                      col.className,
                    )}
                  >
                    {col.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showSkeleton
                ? [
                    <TableRow key="skeleton-status" className="hover:bg-transparent">
                      <TableCell colSpan={columns.length} className="p-0">
                        <span role="status" aria-label="Loading" className="sr-only">
                          Loading
                        </span>
                      </TableCell>
                    </TableRow>,
                    ...Array.from({ length: skeletonRows }, (_, i) => (
                      <TableRow key={`skeleton-row-${i}`} aria-hidden="true">
                        {columns.map((col) => (
                          <TableCell key={`skeleton-cell-${i}-${col.key}`}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    )),
                  ]
                : showEmpty
                  ? emptyState
                    ? (
                        <TableRow>
                          <TableCell
                            colSpan={columns.length}
                            className="p-0"
                          >
                            {emptyState}
                          </TableCell>
                        </TableRow>
                      )
                    : null
                  : rows.map((row) => (
                      <TableRow
                        key={getRowKey(row)}
                        className={cn(onRowClick && "cursor-pointer")}
                        tabIndex={onRowClick ? 0 : undefined}
                        onClick={
                          onRowClick
                            ? (e) => {
                                // Don't hijack clicks on nested interactive controls.
                                if (
                                  (e.target as HTMLElement).closest(
                                    'button,a,input,select,textarea,[role="button"],[role="menuitem"]',
                                  )
                                ) {
                                  return
                                }
                                // Ignore activation while a stale-revalidate dim is in effect.
                                if (showDimmed) return
                                onRowClick(row)
                              }
                            : undefined
                        }
                        onKeyDown={
                          onRowClick
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  if (
                                    (e.target as HTMLElement).closest(
                                      'button,a,input,select,textarea,[role="button"],[role="menuitem"]',
                                    )
                                  ) {
                                    return
                                  }
                                  e.preventDefault()
                                  if (showDimmed) return
                                  onRowClick(row)
                                }
                              }
                            : undefined
                        }
                      >
                        {columns.map((col) => (
                          <TableCell
                            key={col.key}
                            className={col.className}
                          >
                            {col.cell(row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Footer (typically a Pager) */}
      {footer && (
        <div className="border-t px-4">
          {footer}
        </div>
      )}
    </Card>
  )
}
