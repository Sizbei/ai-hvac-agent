import { ChevronDown } from 'lucide-react';
import type { StepRow } from '@/lib/admin/setup-view';
import { SetupStepRow } from '@/components/admin/setup/setup-step-row';

interface StepListProps {
  readonly rows: readonly StepRow[];
  readonly justDone: ReadonlySet<string>;
  /** Step id whose action the hero already shows. */
  readonly heroId?: string;
}

export function StepList({ rows, justDone, heroId }: StepListProps) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <SetupStepRow
          // Remount when `done` flips so the just-done row starts from its enter state.
          key={`${row.step.id}:${row.step.done}`}
          row={row}
          justDone={justDone.has(row.step.id)}
          showAction={row.step.id !== heroId}
        />
      ))}
    </ul>
  );
}

interface SetupPhaseCardProps extends Omit<StepListProps, 'rows'> {
  readonly title: string;
  readonly meta?: string;
  readonly rows: readonly StepRow[];
  /** Done phases render closed; a just-done row keeps it open so the change is seen. */
  readonly collapsed?: boolean;
}

/**
 * Phase panel in the SectionCard look, built on a native `<details>` so a done
 * phase collapses to its header and can be reopened without any state.
 */
export function SetupPhaseCard({ title, meta, rows, collapsed = false, justDone, heroId }: SetupPhaseCardProps) {
  const keepOpen = rows.some((r) => justDone.has(r.step.id));
  return (
    <details
      open={!collapsed || keepOpen}
      className="group overflow-hidden rounded-lg border border-border-strong bg-surface"
    >
      <summary
        className="flex h-10 cursor-pointer list-none items-center gap-2 border-b border-border-strong bg-surface-sunken px-4 group-not-open:border-b-0 [&::-webkit-details-marker]:hidden"
        style={{ boxShadow: 'var(--keyline-top)' }}
      >
        <h2 className="min-w-0 truncate text-[15px] font-semibold leading-none text-foreground">{title}</h2>
        {meta && (
          <span className="shrink-0 font-mono text-[13px] leading-none tabular-nums text-muted-foreground">{meta}</span>
        )}
        <ChevronDown
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-foreground-faint transition-transform duration-[var(--dur-hover)] group-open:rotate-180"
        />
      </summary>
      <div className="p-4">
        <StepList rows={rows} justDone={justDone} heroId={heroId} />
      </div>
    </details>
  );
}
