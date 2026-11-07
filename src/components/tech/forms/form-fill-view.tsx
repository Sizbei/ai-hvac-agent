'use client';

import type { MouseEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FormFieldInput } from '@/components/tech/forms/form-field-input';
import { FillConfirmSheet } from '@/components/tech/forms/form-fill-sheets';
import type { FormField } from '@/lib/forms/form-schema';
import { answersHidden, unparsedIds, type InputValue, type Inputs } from '@/lib/tech/form-fill-state';
import type { StopReason } from '@/lib/tech/form-save-machine';
import { backHref, dayShort, fillHref, readOnlyCopy, statusLine, SUBMITTED_ON, type StatusPhase } from '@/lib/tech/form-copy';
import type { TechFormView } from '@/lib/tech/form-view';

export const GONE = 'This form is no longer on this job.';

export type FillLoad = { kind: 'ok'; view: TechFormView } | { kind: 'gone' } | { kind: 'error' };

/** The fill page's markup (M3d spec §7.3); every decision about saving stays in `FormFillClient`. */
export function FormFillView(p: {
  readonly load: FillLoad;
  readonly jobId: string;
  readonly formId: string;
  readonly visitId: string;
  readonly from: string | null;
  readonly inputs: Inputs;
  readonly phase: StatusPhase;
  readonly savedAt: string | null;
  readonly savedByOther: string | null;
  readonly notice: string | null;
  readonly notSaved: readonly string[];
  readonly highlights: Readonly<Record<string, string>>;
  readonly topLine: string | null;
  readonly typing: boolean;
  readonly stop: StopReason | null;
  readonly keyPhase: string;
  /** An in-app leave is waiting for the save (R1a): the links read "Saving…". */
  readonly leaving: boolean;
  readonly answered: boolean;
  readonly leaveTo: (href: string) => (e: MouseEvent<HTMLAnchorElement>) => void;
  readonly onChange: (field: FormField, v: InputValue) => void;
  readonly onBlurInput: () => void;
  readonly onFocusInput: () => void;
  readonly onTryAgainDraft: () => void;
  readonly onTryAgainSubmit: () => void;
  readonly onSubmitTap: () => void;
  readonly confirmOpen: boolean;
  readonly setConfirmOpen: (open: boolean) => void;
  readonly onConfirmSubmit: () => void;
  readonly clearOpen: boolean;
  readonly setClearOpen: (open: boolean) => void;
  readonly onClear: () => void;
}) {
  const { load, jobId, formId, visitId, from, inputs, phase, leaving, leaveTo } = p;
  if (load.kind === 'gone' || load.kind === 'error') {
    return (
      <Card>
        <CardContent className="space-y-4 py-6">
          <p role="alert" className="text-[17px] font-medium">{load.kind === 'gone' ? GONE : "Couldn't load this form."}</p>
          <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
            <ArrowLeft className="size-4" /> Back to job
          </Link>
        </CardContent>
      </Card>
    );
  }

  const v = load.view;
  const submitted = v.submission?.status === 'submitted' || phase === 'submitted';
  const locked = p.keyPhase === 'sent' || p.keyPhase === 'unknown';
  const writable = v.canWrite && !submitted && !locked && from === null && p.stop !== 'blocked' && p.stop !== 'signed_out' && p.stop !== 'submitted';
  const back = backHref({ jobId, formId, visitId, myVisit: v.myVisit, from });
  const unparsed = unparsedIds(v.form.fields, inputs).length;
  const line = statusLine({
    phase: locked ? (p.keyPhase === 'sent' ? 'submit_sent' : 'submit_unknown') : submitted ? 'submitted' : phase,
    savedAt: p.savedAt, savedByOther: p.savedByOther, unparsedCount: submitted ? 0 : unparsed,
    submittedAt: v.submission?.submittedAt ?? null, submittedByName: v.submission?.submittedByName ?? null, now: new Date(),
  });
  const reasons = readOnlyCopy(v.writeBlockedReason, { myRowCancelled: v.myRowCancelled });
  const backLabel = leaving ? 'Saving…' : back.label;
  const earlier = v.submittedOn ? fillHref(jobId, formId, v.submittedOn.appointmentId, visitId) : null;

  return (
    <div className="space-y-4 pb-28">
      <Link href={back.href} onClick={leaveTo(back.href)} aria-busy={leaving} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
        <ArrowLeft className="size-4" /> {backLabel}
      </Link>
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold">{v.form.name}</h1>
        {v.form.description && <p className="text-[15px] text-muted-foreground">{v.form.description}</p>}
        {line && <p className="text-[13px] text-muted-foreground">{line}</p>}
      </header>

      {v.submittedOn && earlier && !submitted && from === null && (
        <p className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">
          {SUBMITTED_ON(v.submittedOn.appointmentNumber, dayShort(v.submittedOn.submittedAt))}{' '}
          <Link className="text-link underline" href={earlier} onClick={leaveTo(earlier)}>
            {leaving ? 'Saving…' : <>View visit #{v.submittedOn.appointmentNumber}&apos;s answers</>}
          </Link>
        </p>
      )}
      {reasons.map((r) => (
        <p key={r} role="status" className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">{r}</p>
      ))}
      {p.notice && <p role="status" className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">{p.notice}</p>}
      {phase === 'signed_out' && (
        <Link href="/tech-login" className="inline-flex h-11 items-center rounded-xl border px-4 text-[15px]">Sign in</Link>
      )}
      {p.notSaved.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground">{p.notSaved.map((l) => <li key={l}>{l}</li>)}</ul>
      )}
      {p.topLine && <p role="alert" className="text-[15px] text-danger-strong">{p.topLine}</p>}

      <Card>
        {/* The card has its own vertical padding; a leading heading drops its top gap. */}
        <CardContent className="space-y-4 [&>div:first-child_h3]:pt-0">
          {answersHidden(v.submission) ? (
            // Erased or unreadable: no field values at all (an empty checkbox would read "Not done").
            <p className="text-[15px] text-muted-foreground">{v.submission?.erased ? 'Answers removed' : "These answers can't be shown."}</p>
          ) : v.form.fields.map((f) => (
            <div key={f.id} id={`q-${f.id}`}>
              <FormFieldInput
                field={f}
                value={inputs[f.id]}
                readOnly={!writable}
                highlight={p.highlights[f.id] ?? null}
                onChange={(x) => p.onChange(f, x)}
                onBlur={p.onBlurInput}
                onFocusInput={p.onFocusInput}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {writable && p.answered && (
        <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" onClick={() => p.setClearOpen(true)}>Clear answers</Button>
      )}

      <footer className={`${p.typing ? '' : 'sticky bottom-0'} space-y-2 border-t bg-background py-3`}>
        <p aria-live="polite" className="text-[13px] text-muted-foreground">{line === 'Saving…' ? '' : line}</p>
        {phase === 'bad_request' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={p.onTryAgainDraft}>Try again</Button>
        )}
        {p.keyPhase === 'unknown' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={p.onTryAgainSubmit}>Try again</Button>
        )}
        {submitted ? (
          <Link
            href={back.href} onClick={leaveTo(back.href)}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary text-[16px] text-primary-foreground"
          >
            {backLabel}
          </Link>
        ) : writable ? (
          <Button className="h-12 w-full rounded-xl text-[16px]" onClick={p.onSubmitTap}>Submit form</Button>
        ) : null}
      </footer>

      <FillConfirmSheet
        open={p.confirmOpen} onOpenChange={p.setConfirmOpen} title={`Submit “${v.form.name}”?`}
        description="After this, only the office can reopen it." confirmLabel="Submit" onConfirm={p.onConfirmSubmit}
      />
      <FillConfirmSheet open={p.clearOpen} onOpenChange={p.setClearOpen} title="Clear all answers on this form?" confirmLabel="Clear answers" onConfirm={p.onClear} />
    </div>
  );
}
