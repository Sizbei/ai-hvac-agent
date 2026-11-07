'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ListChecks, Plus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { plural } from '@/lib/format/plural';
import type { FormListRow } from '@/lib/admin/form-queries';
import type { JobTypeRecord } from '@/lib/admin/job-type-types';
import { formsTabAppliesTo, formatChangedAt } from '@/lib/admin/forms-tab';

/** Settings → Forms (M3d spec §7.1): active forms by name, archived last. */
export function FormsPanel() {
  const [forms, setForms] = useState<readonly FormListRow[] | null>(null);
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [fr, jr] = await Promise.all([fetch('/api/admin/settings/forms'), fetch('/api/admin/settings/job-types')]);
        const [fb, jb] = await Promise.all([fr.json(), jr.json().catch(() => null)]);
        if (!live) return;
        if (!fr.ok || !fb?.success) {
          setFailed(true);
          return;
        }
        setForms(fb.data.forms as FormListRow[]);
        setJobTypes(jr.ok && jb?.success ? (jb.data.jobTypes as JobTypeRecord[]) : []);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const newButton = (
    <Link href="/admin/settings/forms/new" className={buttonVariants({ size: 'sm' })}>
      <Plus className="size-4" aria-hidden="true" /> New form
    </Link>
  );

  if (failed && forms === null) {
    return <LoadErrorState title="Couldn't load forms." onRetry={() => setAttempt((n) => n + 1)} />;
  }

  return (
    <SectionCard title="Forms" icon={ListChecks} count={forms?.length} action={forms && forms.length > 0 ? newButton : undefined}>
      {forms === null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : forms.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No forms yet."
          description="Forms you build here show in the technician app."
          action={newButton}
        />
      ) : (
        <ul className="divide-y">
          {forms.map((f) => (
            <li key={f.id}>
              <Link href={`/admin/settings/forms/${f.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-sunken">
                <span className={f.active ? 'font-medium' : 'font-medium text-muted-foreground'}>{f.name}</span>
                <span className="text-muted-foreground">{plural(f.questionCount, 'question', 'questions')}</span>
                <span className="text-muted-foreground">{formsTabAppliesTo(f.jobTypeIds, jobTypes)}</span>
                {f.required && <span className="rounded-[3px] border px-1.5 py-0.5 text-xs font-medium">Required</span>}
                {!f.active && <span className="rounded-[3px] border px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>}
                <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{formatChangedAt(f.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
