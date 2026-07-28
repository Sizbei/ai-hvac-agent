"use client"

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface PagerProps {
  readonly page: number
  readonly totalPages: number
  /** Total item count — used to render "Showing X–Y of Z". */
  readonly total?: number
  /** Items per page — required when `total` is provided. */
  readonly perPage?: number
  readonly onPageChange: (page: number) => void
  /** Show first/last jump buttons. Defaults to false. */
  readonly showFirstLast?: boolean
  readonly className?: string
}

/** Derives the "Showing X–Y of Z" label. */
function rangeLabel(page: number, total: number, perPage: number): string {
  if (total === 0) return "No results"
  const from = (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  return `Showing ${from}–${to} of ${total}`
}

/**
 * Stateless pager — replaces 6+ ad-hoc pagers across requests, conversations,
 * customers, reviews, invoices, estimates, pricebook, inventory, and audit-log.
 *
 * Uses Lucide ChevronLeft/Right icons (not ASCII arrows) with 44 px min touch
 * targets for mobile. Label is centered between nav controls.
 */
export function Pager({
  page,
  totalPages,
  total,
  perPage,
  onPageChange,
  showFirstLast = false,
  className,
}: PagerProps) {
  const safeTotal = Math.max(1, totalPages)
  const safePage = Math.min(Math.max(1, page), safeTotal)
  const atFirst = safePage <= 1
  const atLast = safePage >= safeTotal

  const label =
    total !== undefined && perPage !== undefined
      ? rangeLabel(safePage, total, perPage)
      : `Page ${safePage} of ${safeTotal}`

  return (
    <nav
      className={cn("flex items-center justify-between gap-4 px-1 py-3", className)}
      role="navigation"
      aria-label="Pagination"
    >
      {/* Left controls */}
      <div className="flex items-center gap-1">
        {showFirstLast && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="First page"
            onClick={() => onPageChange(1)}
            disabled={atFirst}
            className="min-h-[44px] min-w-[44px]"
          >
            <ChevronsLeft className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Previous page"
          onClick={() => onPageChange(safePage - 1)}
          disabled={atFirst}
          className="min-h-[44px]"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          <span>Prev</span>
        </Button>
      </div>

      {/* Center label */}
      <span className="flex-1 text-center text-xs tabular-nums text-muted-foreground">
        {label}
      </span>

      {/* Right controls */}
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Next page"
          onClick={() => onPageChange(safePage + 1)}
          disabled={atLast}
          className="min-h-[44px]"
        >
          <span>Next</span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        {showFirstLast && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Last page"
            onClick={() => onPageChange(safeTotal)}
            disabled={atLast}
            className="min-h-[44px] min-w-[44px]"
          >
            <ChevronsRight className="size-4" />
          </Button>
        )}
      </div>
    </nav>
  )
}
