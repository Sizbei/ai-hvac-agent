"use client"

import { useRef } from "react"
import { cn } from "@/lib/utils"

interface SegmentedOption<T extends string = string> {
  /** The value passed to onChange. */
  readonly value: T
  /** Display label — sentence case, no uppercase. */
  readonly label: string
  /** Optional numeric badge rendered next to the label. */
  readonly badge?: number
}

interface SegmentedControlProps<T extends string = string> {
  readonly options: ReadonlyArray<SegmentedOption<T>>
  readonly value: T
  readonly onChange: (value: T) => void
  /** Accessible label for the control group. */
  readonly "aria-label"?: string
  readonly className?: string
}

/**
 * Segmented control — canonical data-workspace filter.
 * Fused strip: one bordered container, 1px hairlines between options, no pills
 * and no gaps. Active segment is a filled navy position, like a selector switch.
 * Replaces the 3-per-page hand-rolled pill/underline/native-select filters
 * in invoices, estimates, and pricebook.
 *
 * No raw Tailwind palette classes. Tokens only.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null)

  // Radio pattern: arrows (and Home/End) move focus AND selection.
  function handleKeyDown(
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next = index
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (index + 1) % options.length
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (index - 1 + options.length) % options.length
    } else if (e.key === "Home") {
      next = 0
    } else if (e.key === "End") {
      next = options.length - 1
    } else {
      return
    }
    e.preventDefault()
    onChange(options[next].value)
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      ?.[next]?.focus()
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-[30px] items-center overflow-hidden rounded-md border border-border-strong bg-surface-raised max-md:h-11",
        className,
      )}
    >
      {options.map((opt, index) => {
        const isActive = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "inline-flex h-full items-center gap-1.5 border-l border-border px-3 text-[13px] font-medium transition-colors duration-[var(--dur-hover)] first:border-l-0 focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              isActive
                ? "bg-primary font-semibold text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {opt.label}
            {opt.badge !== undefined && (
              <span
                aria-label={`${opt.badge} items`}
                className={cn(
                  "inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] px-1 font-mono text-[10px] font-semibold tabular-nums",
                  isActive
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-surface-sunken text-foreground",
                )}
              >
                {opt.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
