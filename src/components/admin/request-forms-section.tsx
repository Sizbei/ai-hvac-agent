'use client';

import { useCallback, useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { cn } from '@/lib/utils';
import { answerText } from '@/lib/forms/form-values';
import type { OfficeSubmission, RequestForms } from '@/lib/admin/form-queries';
import {
  missingLine, REOPEN_STALE, REOPEN_TITLE, reopenDescription, submissionChip, visitLabel, whoWhen,
} from '@/lib/admin/request-forms-view';

/**
 * The request detail sheet's Forms section, after Visits (M3d spec §7.5): each
 * submission with its answers (range notes included), the required forms not
 * submitted yet, and Reopen for submitted ones. `refreshKey` reloads it.
 */
export function RequestFormsSection({
  requestId,
  requestStatus,
  refreshKey,
}: {
  readonly requestId: string;
  readonly requestStatus: string;
  readonly refreshKey: string;
}) {
  const [data, setData] = useState<RequestForms | null>(null);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<OfficeSubmission | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/forms`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setData(body.data as RequestForms);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function reopen(): Promise<void> {
    if (!target) return;
    setReopening(true);
    setReopenError(null);
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/forms/${target.id}/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: target.revision }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setTarget(null);
        await load();
      } else {
        setReopenError(body?.error?.code === 'STALE' ? REOPEN_STALE : "Couldn't reopen the form. Please try again.");
      }
    } catch {
      setReopenError("Couldn't reopen the form. Please try again.");
    } finally {
      setReopening(false);
    }
  }

  if (data === null && !failed) {
    return (
      <SectionCard title="Forms" icon={ListChecks}>
        <div className="space-y-2 p-4"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      </SectionCard>
    );
  }
  if (data === null) {
    return (
      <SectionCard title="Forms" icon={ListChecks}>
        <p role="alert" className="p-4 text-sm text-destructive">
          Couldn&apos;t load forms.{' '}
          <button type="button" className="underline" onClick={() => void load()}>Try again</button>
        </p>
      </SectionCard>
    );
  }
  if (data.submissions.length === 0 && data.missingRequired.length === 0) return null;

  return (
    <>
      <SectionCard title="Forms" icon={ListChecks} count={data.submissions.length}>
        {data.missingRequired.length > 0 && (
          <ul className="space-y-1 border-b px-4 py-2.5 text-sm">
            {data.missingRequired.map((m) => {
              const line = missingLine(m.name, requestStatus);
              return <li key={m.formId} className={cn(line.warning && 'text-warning-strong')}>{line.text}</li>;
            })}
          </ul>
        )}
        <ul className="divide-y">
          {data.submissions.map((s) => (
            <li key={s.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.formName}</span>
                <span className="text-muted-foreground">{visitLabel(s)}</span>
                <span className="rounded-[3px] border px-1.5 py-0.5 text-xs">{submissionChip(s)}</span>
                {s.status === 'submitted' && !s.erased && (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => { setReopenError(null); setTarget(s); }}>
                    Reopen
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{whoWhen(s)}</p>
              {s.values && (
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  {s.fields.map((f) =>
                    f.type === 'heading' ? (
                      <dt key={f.id} className="pt-1 font-medium sm:col-span-2">{f.label}</dt>
                    ) : (
                      <div key={f.id} className="contents">
                        <dt className="text-muted-foreground">{f.label}</dt>
                        <dd>{answerText(f, s.values?.[f.id])}</dd>
                      </div>
                    ),
                  )}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </SectionCard>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => { if (!o) setTarget(null); }}
        title={REOPEN_TITLE}
        description={reopenDescription(target?.visitHasTechnician ?? true)}
        confirmLabel="Reopen"
        isConfirming={reopening}
        error={reopenError}
        onConfirm={() => void reopen()}
      />
    </>
  );
}
