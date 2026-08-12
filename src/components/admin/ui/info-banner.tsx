import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface InfoBannerProps {
  /** Banner body — sentence-case copy explaining the informational context. */
  readonly children: React.ReactNode;
  /** Optional leading icon. Defaults to `Info`. */
  readonly icon?: typeof Info;
  readonly className?: string;
}

/**
 * Informational banner backed by the `--info` token — replaces the hardcoded
 * violet/sky info strips (synced-source notice, integration/sync surfaces).
 *
 * Tokens only: no raw Tailwind palette classes.
 */
export function InfoBanner({ children, icon: Icon = Info, className }: InfoBannerProps) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-info-border bg-info-light px-3 py-2 text-[13px] leading-5 text-info-strong",
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-info-strong" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
