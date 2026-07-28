"use client"

import { useCallback, useRef } from "react"
import { cn } from "@/lib/utils"

interface TabItem {
  /** Unique id — used as aria `id` and `aria-controls`. */
  readonly id: string
  /** Display label — sentence case. */
  readonly label: string
  /** Optional badge count shown next to the label. */
  readonly badge?: number
}

interface TabGroupProps {
  readonly tabs: ReadonlyArray<TabItem>
  readonly activeTab: string
  readonly onTabChange: (id: string) => void
  /** Accessible label for the tablist landmark. */
  readonly "aria-label"?: string
  /** Id prefix for panel regions (e.g. `"panel"` → `"panel-${tab.id}"`). */
  readonly panelIdPrefix?: string
  readonly className?: string
}

/**
 * Accessible tab group — adds role="tablist"/role="tab"/aria-selected +
 * arrow-key navigation around a Button-based visual.
 *
 * Manual activation (WAI-ARIA): arrows/Home/End move focus only via roving
 * tabindex; Enter/Space activates the focused tab. Manual (not automatic)
 * because tab switches here fetch data — auto-activation is only appropriate
 * when panels render without latency.
 *
 * Replaces the calendar view toggle and conversation channel tabs which were
 * plain Buttons with no keyboard/aria semantics.
 *
 * Visual: pill underline style using --primary for the active indicator.
 * No raw Tailwind palette classes.
 */
export function TabGroup({
  tabs,
  activeTab,
  onTabChange,
  "aria-label": ariaLabel,
  panelIdPrefix,
  className,
}: TabGroupProps) {
  const listRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      )
      if (!buttons) return

      // Enter/Space activate the focused tab (manual activation).
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        onTabChange(tabs[index].id)
        return
      }

      // Arrows/Home/End move focus only — activation is deferred to Enter/Space.
      let next = index
      if (e.key === "ArrowRight") {
        next = (index + 1) % tabs.length
        e.preventDefault()
      } else if (e.key === "ArrowLeft") {
        next = (index - 1 + tabs.length) % tabs.length
        e.preventDefault()
      } else if (e.key === "Home") {
        next = 0
        e.preventDefault()
      } else if (e.key === "End") {
        next = tabs.length - 1
        e.preventDefault()
      } else {
        return
      }

      buttons[next]?.focus()
    },
    [tabs, onTabChange],
  )

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0 border-b border-border",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={
              panelIdPrefix ? `${panelIdPrefix}-${tab.id}` : undefined
            }
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "relative inline-flex min-h-[44px] items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              isActive
                ? "text-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span
                aria-label={`${tab.badge} items`}
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums text-foreground"
              >
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
