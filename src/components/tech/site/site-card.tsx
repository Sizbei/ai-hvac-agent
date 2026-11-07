'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { siteCardLine } from '@/lib/tech/site-display';
import type { SiteView } from '@/lib/tech/site-view';
import { fetchSite } from './fetch-site';

/** The job page's Site card, after Forms (M3d spec §7.6). Not tappable when the page would be all empty. */
export function SiteCard({ jobId }: { readonly jobId: string }) {
  const [view, setView] = useState<SiteView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSite(jobId).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  if (view === null) return null; // a failed load hides the card; the page itself shows its error
  const line = view ? siteCardLine(view) : null;
  const body = (
    <span className="flex min-h-11 items-center gap-2 text-[15px]">
      <span className="flex-1">{line ? line.text : <Skeleton className="h-5 w-40" />}</span>
      {line?.tappable && <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
    </span>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Site</CardTitle>
      </CardHeader>
      <CardContent>
        {line?.tappable ? <Link href={`/tech/jobs/${jobId}/site`} className="block active:bg-accent">{body}</Link> : body}
      </CardContent>
    </Card>
  );
}
