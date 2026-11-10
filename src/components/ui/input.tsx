import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  ref,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        // Recessed instrument field: white well, hairline input border, 1px
        // inset shadow. Focus = 2px ring outline offset 1px (never a soft glow).
        "h-[34px] max-sm:min-h-11 w-full min-w-0 rounded-md border border-border-input bg-surface-raised px-2.5 py-1 text-base text-foreground shadow-[inset_0_1px_2px_oklch(0.245_0.010_95/0.05)] transition-[background-color,border-color] duration-[var(--dur-hover)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-foreground-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-foreground disabled:shadow-none aria-invalid:border-danger aria-invalid:focus-visible:outline-danger md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
