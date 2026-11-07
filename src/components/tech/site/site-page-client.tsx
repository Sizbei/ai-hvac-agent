'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { estimateHref, estimateTotal, membershipLines, pastJobLine, SITE_COPY, unaddressedLine } from '@/lib/tech/site-display';
import type { SiteView } from '@/lib/tech/site-view';
import { fetchSite } from './fetch-site';

const CHIP = 'rounded-[3px] border px-1.5 py-0.5 text-[13px]';

/** What the technician should know about this address (M3d spec §7.6). Rows aren't links, except this job's open estimates for the lead. */
export function SitePageClient({ jobId }: { readonly jobId: string }) {
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

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to job
    </Link>
  );
  if (view === undefined) return <div className="space-y-4">{back}<Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (view === null) return <div className="space-y-4">{back}<p role="alert" className="text-[15px]">Couldn&apos;t load this site.</p></div>;

  const m = membershipLines(view.membership);
  const unaddressed = unaddressedLine(view.unaddressedCount);
  return (
    <div className="space-y-4">
      {back}
      <h1 className="text-[20px] font-semibold">{view.title}</h1>
      {!view.hasCustomer ? (
        <p className="text-[15px] text-muted-foreground">{SITE_COPY.noCustomer}</p>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-[17px]">At this address</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <section className="space-y-1.5">
                <h2 className="text-[15px] font-semibold">Past jobs</h2>
                {view.scope === 'none' ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noAddress}</p>
                ) : view.pastJobs.length === 0 ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noPastJobs}</p>
                ) : (
                  <ul className="space-y-1.5">{view.pastJobs.map((j) => <li key={j.id} className="text-[15px]">{pastJobLine(j)}</li>)}</ul>
                )}
                {unaddressed && <p className="text-[13px] text-muted-foreground">{unaddressed}</p>}
              </section>
              <section className="space-y-1.5">
                <h2 className="text-[15px] font-semibold">Open estimates</h2>
                {view.openEstimates.length === 0 ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noEstimates}</p>
                ) : (
                  <ul className="space-y-2">
                    {view.openEstimates.map((e) => {
                      const row = (
                        <span className="block space-y-0.5">
                          <span className="block text-[15px]">{e.label}</span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[14px] tabular-nums">{estimateTotal(e)}</span>
                            {e.thisJob && <span className={CHIP}>This job</span>}
                            {e.fromFieldPulse && <span className={CHIP}>From FieldPulse</span>}
                          </span>
                        </span>
                      );
                      const href = estimateHref(jobId, e, view.isLead);
                      return (
                        <li key={e.id}>
                          {href ? <Link href={href} className="block min-h-11 active:bg-accent">{row}</Link> : row}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-[17px]">Membership</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-[15px]">
              <p>{m.head}</p>
              {m.visits && <p className="text-muted-foreground">{m.visits}</p>}
              {view.membership.state === 'member' && (
                <>
                  <h2 className="pt-2 text-[15px] font-semibold">Upcoming maintenance</h2>
                  {m.upcoming.length === 0 ? (
                    <p className="text-muted-foreground">No visits due.</p>
                  ) : (
                    <ul className="space-y-1">
                      {m.upcoming.map((u) => (
                        <li key={u.text} className="flex flex-wrap items-center gap-1.5">
                          {u.text}{u.thisJob && <span className={CHIP}>This job</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
