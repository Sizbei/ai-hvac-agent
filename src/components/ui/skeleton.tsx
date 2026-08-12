import { cn } from "@/lib/utils"

import "./skeleton.css"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton-breathe rounded-sm bg-surface-sunken", className)}
      {...props}
    />
  )
}

export { Skeleton }
