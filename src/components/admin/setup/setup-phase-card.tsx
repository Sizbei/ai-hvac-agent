import { SectionCard } from '@/components/admin/ui/section-card';
import type { StepRow } from '@/lib/admin/setup-view';
import { SetupStepRow } from '@/components/admin/setup/setup-step-row';

interface StepListProps {
  readonly rows: readonly StepRow[];
  readonly justDone: ReadonlySet<string>;
  /** Step id the hero already shows. */
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
          justDone={row.step.done && justDone.has(row.step.id)}
          heroId={heroId}
        />
      ))}
    </ul>
  );
}

interface SetupPhaseCardProps extends StepListProps {
  readonly title: string;
  readonly meta?: string;
  /** Done phases render closed; a just-done row keeps it open so the change is seen. */
  readonly collapsed?: boolean;
}

/** Phase panel: a collapsible SectionCard, closed once its required steps are done. */
export function SetupPhaseCard({ title, meta, rows, collapsed = false, justDone, heroId }: SetupPhaseCardProps) {
  const keepOpen = rows.some((r) => r.step.done && justDone.has(r.step.id));
  return (
    <SectionCard title={title} meta={meta} collapsible open={!collapsed || keepOpen}>
      <StepList rows={rows} justDone={justDone} heroId={heroId} />
    </SectionCard>
  );
}
