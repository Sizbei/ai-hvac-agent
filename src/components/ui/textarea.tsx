import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Textarea — shadcn-style primitive matching Input's focus-ring, border,
 * and sizing conventions. Drop-in replacement for raw `<textarea>` class
 * strings used across settings panels and the template editor.
 */
function Textarea({ className, ref, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        // Same recessed well as Input; height stays natural (rows/min-h).
        "w-full min-w-0 rounded-md border border-border-input bg-surface-raised px-2.5 py-2 text-base text-foreground shadow-[inset_0_1px_2px_oklch(0.245_0.010_95/0.05)] transition-[background-color,border-color] duration-[var(--dur-hover)] outline-none placeholder:text-foreground-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-foreground disabled:shadow-none aria-invalid:border-danger aria-invalid:focus-visible:outline-danger md:text-sm",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
