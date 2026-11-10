'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { parseTourParams, type TourParams } from '@/lib/admin/tour-strip';

/**
 * "Quick tour · Stop n of 5 · Back to tour" (onboarding spec D4). Reads
 * `window.location` once on mount: `useUrlFilterSync` rewrites the query right
 * after mount, and child effects run before parent effects, so mount this
 * unconditionally. No fetch, no writes.
 */
export function BackToTourStrip() {
  const [tour, setTour] = useState<TourParams | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL after mount
    setTour(parseTourParams(new URLSearchParams(window.location.search)));
  }, []);

  if (!tour) return null;
  return (
    <InfoBanner>
      Quick tour · Stop {tour.n} of 5 ·{' '}
      <Link href={tour.href} className="font-medium underline underline-offset-2">
        Back to tour
      </Link>
    </InfoBanner>
  );
}
