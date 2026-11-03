'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { refreshOnboarding, useOnboarding } from '@/lib/admin/onboarding-store';
import { BANNER_DONE, bannerText, type BannerEvent } from '@/lib/admin/setup-card-view';
import type { StepId } from '@/lib/admin/onboarding-state';
import { cn } from '@/lib/utils';

interface BackToGuideBannerProps {
  readonly stepId: StepId;
  readonly event: BannerEvent;
}

/**
 * Slim "Back to guide" strip shown when a page was opened from the setup guide
 * (spec §2). Copy comes from the pure `bannerText`; the Check fades in over
 * 120 ms when the step flips to done.
 */
export function BackToGuideBanner({ stepId, event }: BackToGuideBannerProps) {
  const { data } = useOnboarding();
  useEffect(() => {
    void refreshOnboarding();
  }, []);

  const text = bannerText(data?.steps.find((s) => s.id === stepId), event);
  const done = text === BANNER_DONE;

  return (
    <InfoBanner>
      <span aria-live="polite">
        <Check
          aria-hidden="true"
          className={cn(
            'mr-1 inline-block size-3.5 align-[-2px] transition-opacity duration-[120ms]',
            done ? 'opacity-100' : 'opacity-0',
          )}
        />
        {text} ·{' '}
        <Link href="/admin/setup" className="font-medium underline underline-offset-2">
          Back to guide
        </Link>
      </span>
    </InfoBanner>
  );
}
