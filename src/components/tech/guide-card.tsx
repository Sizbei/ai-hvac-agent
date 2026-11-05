'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GuideFinished } from '@/components/tech/guide-finished';
import { GuideProgress } from '@/components/tech/guide-progress';
import { useTechGuide } from '@/hooks/use-tech-guide';
import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';
import { cardNote, cardState, type TodayFirst } from '@/lib/tech/guide-view';

const SKELETON_DELAY_MS = 300;
/** The common button state (header, bar, eyebrow, title, two-line how, button, link) so the skeleton → card swap never moves the list. */
const CARD_MIN_H = 'min-h-[276px]';

export function GuideCard({ todayFirst, todaySettled, onHidden }: {
  readonly todayFirst: TodayFirst;
  readonly todaySettled: boolean;
  readonly onHidden: () => void;
}) {
  const { data, status, reload } = useTechGuide();
  const [slow, setSlow] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const state = hidden
    ? 'hidden'
    : cardState(data, { loading: status === 'loading', failed: status === 'failed', slowElapsed: slow, guideHidden: false, todaySettled });

  // One live region stays mounted for the card's whole life so the × hint is announced when it fills.
  const statusRegion = (
    <div role="status" aria-live="polite">
      {hidden ? <p className="text-[13px] text-muted-foreground">{GUIDE_COPY.hint}</p> : null}
    </div>
  );

  // Same fragment shape in every branch so React keeps the region mounted.
  if (state === 'hidden' || state === 'nothing') return <>{statusRegion}</>;
  if (state === 'skeleton' || !data) {
    return (
      <>
      {statusRegion}
      <Card className={CARD_MIN_H}>
        <CardContent className="space-y-3" aria-hidden="true">
          <div className="flex h-6 items-center justify-between"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-10" /></div>
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
      </>
    );
  }

  async function hide(): Promise<void> {
    setHidden(true);
    setFailed(false);
    onHidden();
    try {
      const res = await fetch('/api/tech/guide', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      if (!res.ok) throw new Error('hide failed');
      void reload();
    } catch {
      setHidden(false);
      setFailed(true);
    }
  }

  const finished = state === 'finished';
  const up = data.steps.find((s) => s.id === data.upNext);
  const note = up ? cardNote(up, data.hasOpenJob, todayFirst) : undefined;
  const showButton = !finished && todayFirst !== 'unknown' && todayFirst !== null;

  return (
    <>
    {statusRegion}
    <Card className={CARD_MIN_H}>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold">{GUIDE_COPY.cardTitle}</h2>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
              {progressLabel(data.progress.requiredDone, data.progress.requiredTotal, '')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="-my-2.5 -mr-2.5 size-11"
              aria-label={finished ? GUIDE_COPY.closeAria : GUIDE_COPY.hideAria}
              onClick={() => void hide()}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <GuideProgress done={data.progress.requiredDone} total={data.progress.requiredTotal} showLabel={false} />
        {finished ? (
          <GuideFinished />
        ) : up ? (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{GUIDE_COPY.upNext}</p>
            <p className="text-[17px] font-semibold">{up.title}</p>
            <p className="text-[13px] text-muted-foreground">{up.how}</p>
            {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
            {showButton && (
              <Button className="h-12 w-full rounded-xl text-[16px]" render={<Link href={todayFirst.href} />}>
                {GUIDE_COPY.openJob}
              </Button>
            )}
          </div>
        ) : null}
        <Link href="/tech/guide" className="-mb-3 inline-flex min-h-11 items-center text-[13px] font-medium text-link">
          {GUIDE_COPY.seeAll}
        </Link>
        {failed && <p role="alert" className="text-[13px] text-danger-strong">{GUIDE_COPY.updateFailed}</p>}
      </CardContent>
    </Card>
    </>
  );
}
