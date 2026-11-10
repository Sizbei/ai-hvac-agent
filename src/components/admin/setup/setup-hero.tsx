import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/admin/ui/section-card';
import { StepGlyph } from '@/components/admin/ui/step-glyph';
import { CopySignInLink } from '@/components/admin/setup/copy-sign-in-link';
import type { DerivedStep } from '@/lib/admin/onboarding-steps';
import { cn } from '@/lib/utils';

interface SetupHeroProps {
  readonly step: DerivedStep;
  /** 1-based display number of the step (shown on the to-do glyph). */
  readonly number: number;
  /** The step re-opened: warning glyph and a "Needs attention" header. */
  readonly attention?: boolean;
  /** `outline` while the quick tour sits expanded above the hero: one primary per screen. */
  readonly actionVariant?: 'default' | 'outline';
}

function HeroAction({ step, variant }: { step: DerivedStep; variant: 'default' | 'outline' }) {
  if (step.action === 'copy_sign_in_link' && step.copyValue) {
    return <CopySignInLink url={step.copyValue} instruction={step.instruction ?? ''} variant={variant} />;
  }
  if (step.instruction) {
    return <p className="text-[13px] leading-5 text-muted-foreground">{step.instruction}</p>;
  }
  if (!step.href) return null;
  return (
    <Button variant={variant} className="w-full sm:w-auto" render={<Link href={step.href} />}>
      {step.hrefLabel}
    </Button>
  );
}

/** Hero slot (spec §8): the Up-next step, or the step that needs attention. */
export function SetupHero({ step, number, attention = false, actionVariant = 'default' }: SetupHeroProps) {
  return (
    <SectionCard title={attention ? 'Needs attention' : 'Up next'} meta={step.estimateLabel}>
      <div className="flex gap-3">
        <StepGlyph state={attention ? 'attention' : 'todo'} number={number} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <p className="text-[16px] font-semibold leading-6 text-foreground">{step.title}</p>
            <p className="text-[13px] leading-5 text-muted-foreground">{step.why}</p>
            {step.note && (
              <p className={cn('text-[13px] leading-5', attention ? 'text-warning-strong' : 'text-muted-foreground')}>
                {step.note}
              </p>
            )}
          </div>
          <HeroAction step={step} variant={actionVariant} />
        </div>
      </div>
    </SectionCard>
  );
}
