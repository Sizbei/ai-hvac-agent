import { Check } from 'lucide-react';
import { IconChip } from '@/components/admin/ui/icon-chip';
import { SectionCard } from '@/components/admin/ui/section-card';
import { StepList } from '@/components/admin/setup/setup-phase-card';
import type { StepRow } from '@/lib/admin/setup-view';

const WINS = [
  'Your technician can sign in',
  'Your first request is booked',
  "It's on a technician's phone",
] as const;

interface SetupFinishedProps {
  readonly optionalRows: readonly StepRow[];
  readonly optionalMeta: string;
  readonly justDone: ReadonlySet<string>;
}

/** Finishing moment (spec §4): the three wins, then the optional steps under "Go further". */
export function SetupFinished({ optionalRows, optionalMeta, justDone }: SetupFinishedProps) {
  return (
    <SectionCard title="You're ready to run requests" contentClassName="p-0">
      <ul className="space-y-2.5 p-4">
        {WINS.map((win) => (
          <li key={win} className="flex items-center gap-3">
            <IconChip icon={Check} intent="success" size="sm" />
            <span className="text-[14px] font-medium leading-5 text-foreground">{win}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-border p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-foreground">{optionalMeta}</h3>
        <StepList rows={optionalRows} justDone={justDone} />
      </div>
    </SectionCard>
  );
}
