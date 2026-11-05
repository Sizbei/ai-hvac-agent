'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GuideFinished } from '@/components/tech/guide-finished';
import { GuideProgress } from '@/components/tech/guide-progress';
import { GuideStepRow } from '@/components/tech/guide-step-row';
import { useTechGuide } from '@/hooks/use-tech-guide';
import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';
import { glyphFor } from '@/lib/tech/guide-view';

const SKELETON_DELAY_MS = 300;

export function GuidePageClient() {
  const { data, status, reload } = useTechGuide();
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const header = (
    <div className="space-y-3">
      <Link href="/tech/jobs" className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {GUIDE_COPY.back}
      </Link>
      <h1 className="text-[20px] font-semibold tracking-tight">{GUIDE_COPY.pageTitle}</h1>
    </div>
  );

  if (!data) {
    if (status === 'failed') {
      return (
        <div className="space-y-4">
          {header}
          <p className="text-[15px] text-danger-strong">{GUIDE_COPY.loadFailed}</p>
          <Button
            variant="outline"
            className="h-11"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void reload().finally(() => setRetrying(false));
            }}
          >
            {retrying ? GUIDE_COPY.loading : GUIDE_COPY.tryAgain}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {header}
        {slow && (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-1.5 w-full rounded-full" />
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        )}
      </div>
    );
  }

  const up = data.steps.find((s) => s.id === data.upNext);
  const run = data.steps.filter((s) => s.group === 'run');
  const further = data.steps.filter((s) => s.group === 'further');
  // The hero shows the up-next how line; the row repeats it only when there is no hero (finished).
  const showHow = (id: string) => data.finished || id !== data.upNext;

  return (
    <div className="space-y-4">
      {header}
      <GuideProgress done={data.progress.requiredDone} total={data.progress.requiredTotal} />
      {data.finished ? (
        <Card><CardContent className="p-4"><GuideFinished /></CardContent></Card>
      ) : up ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{GUIDE_COPY.upNext}</p>
            <p className="text-[17px] font-semibold">{up.title}</p>
            <p className="text-[15px]">{up.why}</p>
            <p className="text-[13px] text-muted-foreground">{up.how}</p>
            {up.note && <p className="text-[13px] text-muted-foreground">{up.note}</p>}
            <Button className="h-12 w-full rounded-xl text-[16px]" render={<Link href="/tech/jobs" />}>{GUIDE_COPY.goToJobs}</Button>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle className="text-[17px]">{GUIDE_COPY.runTitle}</CardTitle></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {run.map((s) => <GuideStepRow key={s.id} step={s} glyph={glyphFor(s, data.upNext)} showHow={showHow(s.id)} />)}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-[17px]">{GUIDE_COPY.furtherTitle}</CardTitle>
          <span className="font-mono text-[13px] tabular-nums text-muted-foreground">{progressLabel(data.progress.optionalDone, data.progress.optionalTotal, '')}</span>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {further.map((s) => <GuideStepRow key={s.id} step={s} glyph={glyphFor(s, data.upNext)} showHow={showHow(s.id)} />)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
