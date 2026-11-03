import { AlertTriangle, Check } from "lucide-react";
import { IconChip } from "@/components/admin/ui/icon-chip";

export type StepGlyphState = "done" | "todo" | "attention";

interface StepGlyphProps {
  readonly state: StepGlyphState;
  /** 1-based step number, shown while the step is to do. */
  readonly number: number;
  readonly className?: string;
}

/**
 * Status glyph for a setup-guide row: done = `Check` on success, to do = the
 * step number on neutral, needs attention = `AlertTriangle` on warning.
 * Decorative — the row's text carries the status for screen readers.
 */
export function StepGlyph({ state, number, className }: StepGlyphProps) {
  if (state === "done") {
    return <IconChip icon={Check} intent="success" size="sm" className={className} />;
  }
  if (state === "attention") {
    return <IconChip icon={AlertTriangle} intent="warning" size="sm" className={className} />;
  }
  return (
    <IconChip intent="neutral" size="sm" className={className}>
      <span aria-hidden="true" className="font-mono text-[11px] font-medium leading-none tabular-nums">
        {number}
      </span>
    </IconChip>
  );
}
