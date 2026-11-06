'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SignaturePad } from '@/components/tech/signature-pad';
import { formatCentsExact } from '@/lib/admin/money-format';
import { mintKey } from '@/lib/http/idempotency-codes';
import {
  approvalButtonLabel,
  approvalStep,
  FINALIZING,
  NO_SIGNATURE_ACTION,
  NO_SIGNATURE_CONFIRM,
  NO_SIGNATURE_PROMPT,
  noSignatureOffered,
  padVisible,
  SIGNATURE_DIDNT_SAVE,
  ZERO_TOTAL_COPY,
  type SendStatus,
} from '@/lib/tech/approval-flow';
import type { TechInvoice } from '@/lib/tech/invoice-view';
import { noteFor, signatureNoteFor, type SheetNote } from '@/lib/tech/sheet-note';
import { InvoiceSignature } from './invoice-record';
import { postJson, type Envelope, type SendResult } from './post-json';
import { NoteLine, TechSheet } from './tech-sheet';
import type { InvoicePageApi, WriteResult } from './use-invoice-writes';

interface Capture {
  readonly blob: Blob;
  readonly name: string;
  readonly hash: string;
  readonly url: string;
}

const FINALIZE_FAILED = "Couldn't finalize the invoice. Try again.";
const landed = (r: WriteResult) => r.status === 'done' || r.status === 'dropped';


/** The job signature: multipart with the held Blob and the intent's key. */
async function sendSignature(jobId: string, c: Capture, key: string): Promise<SendResult> {
  const form = new FormData();
  form.append('file', new File([c.blob], 'signature.png', { type: 'image/png' }));
  form.append('signatureName', c.name);
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/signature`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: form,
    });
    return { status: res.status, envelope: (await res.json().catch(() => null)) as Envelope | null };
  } catch {
    return { status: null };
  }
}

/**
 * "Customer approval" (spec §7.3): pad + printed name, the total, then
 * "Approve and finalize" → the SIGNATURE first (held Blob, same key on every
 * retry), then FINALIZE. A failed signature finalizes nothing; a failed
 * finalize after the signature landed retries only finalize, with the captured
 * signature shown instead of the pad. Stays mounted while closed so a held
 * capture (and its key) survives a close and reopen.
 */
export function ApprovalSheet({
  open,
  onClose,
  onApproved,
  api,
  invoice,
  jobId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onApproved: () => void;
  readonly api: InvoicePageApi;
  readonly invoice: TechInvoice;
  readonly jobId: string;
}) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [sigSent, setSigSent] = useState<SendStatus>('idle');
  // The last signature send ended unknown: only "Try again" (same Blob, same key).
  const [sigUnknown, setSigUnknown] = useState(false);
  const [finSent, setFinSent] = useState<SendStatus>('idle');
  const [busy, setBusy] = useState(false);
  // "Finalize without signature" asks first (it locks the invoice), then reads "Finalizing…".
  const [confirmNoSig, setConfirmNoSig] = useState(false);
  const [noSigBusy, setNoSigBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<SheetNote | null>(null);
  const captureRef = useRef<Capture | null>(null);

  useEffect(() => () => { if (captureRef.current) URL.revokeObjectURL(captureRef.current.url); }, []);

  const step = approvalStep({
    signatureFresh: invoice.signature.fresh,
    signatureSent: sigSent,
    finalizeSent: finSent,
    state: invoice.state,
    captured: capture !== null,
  });

  function hold(next: Capture | null): void {
    if (captureRef.current) URL.revokeObjectURL(captureRef.current.url);
    captureRef.current = next;
    setCapture(next);
  }

  // The pad's "Use this signature" only captures; nothing is sent until "Approve and finalize".
  async function onCapture(blob: Blob, name: string): Promise<void> {
    hold({ blob, name, hash: `${mintKey()}|${name}`, url: URL.createObjectURL(blob) });
    setConfirmNoSig(false);
    setSigSent('idle');
    setMessage(null);
  }

  async function signature(c: Capture): Promise<boolean> {
    setSigSent('sent');
    const r = await api.write({ kind: 'signature' }, (key) => sendSignature(jobId, c, key), { name: c.name }, c.hash);
    if (landed(r)) {
      setSigSent('ok');
      setSigUnknown(false);
      return true;
    }
    // `skipped` is never success: a tap is still in flight or a write is pending.
    setSigSent(r.status === 'skipped' ? 'idle' : 'failed');
    setSigUnknown(r.status === 'retry' || r.status === 'pending');
    setMessage(signatureNoteFor(r, SIGNATURE_DIDNT_SAVE));
    return false;
  }

  async function finalize(): Promise<void> {
    setFinSent('sent');
    const body = { invoiceId: invoice.id };
    const r = await api.write({ kind: 'finalize' }, (key) => postJson(`/api/tech/jobs/${jobId}/invoice/finalize`, body, key), body);
    if (landed(r)) {
      setFinSent('ok');
      hold(null);
      onApproved();
      return;
    }
    setFinSent(r.status === 'skipped' ? 'idle' : 'failed');
    setMessage(noteFor(r, FINALIZE_FAILED));
  }

  /** withSignature=false: the customer isn't here; finalize alone (the invoice reads "No signature"). */
  async function approve(withSignature = true): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNoSigBusy(!withSignature);
    setMessage(null);
    try {
      if (withSignature && step === 'send_signature' && capture && !(await signature(capture))) return;
      await finalize();
    } finally {
      busyRef.current = false;
      setBusy(false);
      setNoSigBusy(false);
    }
  }

  const redraw = () => {
    hold(null);
    setSigSent('idle');
    setMessage(null);
  };

  const pending = api.view.pendingWrite;
  const lastFailure = finSent === 'failed' ? 'finalize' : sigSent === 'failed' ? 'signature' : null;
  const label = busy ? (noSigBusy ? FINALIZING : 'Saving…') : approvalButtonLabel(step, lastFailure);
  const close = () => {
    setConfirmNoSig(false);
    onClose();
  };

  return (
    <TechSheet
      open={open}
      onClose={close}
      busy={busy}
      title="Customer approval"
      description={invoice.totalCents === 0 ? ZERO_TOTAL_COPY : 'The customer signs to approve the work and the total.'}
    >
        <div className="space-y-4 px-4">
          <div className="flex items-baseline justify-between border-b border-border pb-3">
            <span className="text-[15px] text-muted-foreground">Total</span>
            <span className="font-mono text-[20px] font-semibold tabular-nums">{formatCentsExact(invoice.totalCents)}</span>
          </div>

          {padVisible(step) ? (
            <SignaturePad onCapture={onCapture} disabled={busy || pending} captureLabel="Use this signature" />
          ) : capture ? (
            <div className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL of the held capture */}
              <img src={capture.url} alt={`Signature of ${capture.name}`} className="h-24 w-full rounded-md border border-border bg-white object-contain" />
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-[15px] break-words">{capture.name}</p>
                {step === 'send_signature' && (
                  <Button variant="ghost" className="h-11 shrink-0 rounded-xl px-3 text-[15px]" disabled={busy || sigUnknown} onClick={redraw}>
                    Redraw
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <InvoiceSignature signature={invoice.signature} onImageError={() => void api.refetch()} />
          )}

          <NoteLine note={message} />
          {step !== 'show_pad' && step !== 'done' && (
            <Button className="h-12 w-full rounded-xl text-[16px]" disabled={busy || pending} onClick={() => void approve()}>
              {label}
            </Button>
          )}
          {noSignatureOffered(step) && confirmNoSig && (
            <div role="alertdialog" aria-label={NO_SIGNATURE_ACTION} className="space-y-3 rounded-md border border-warning-border bg-warning-light p-3">
              <p className="text-[15px] text-foreground">{NO_SIGNATURE_CONFIRM}</p>
              <div className="flex flex-col gap-2">
                <Button
                  className="h-11 w-full rounded-xl text-[15px]"
                  disabled={busy || pending || sigUnknown}
                  onClick={() => void approve(false)}
                >
                  {noSigBusy ? FINALIZING : NO_SIGNATURE_ACTION}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-full rounded-xl text-[15px]"
                  disabled={busy}
                  onClick={() => setConfirmNoSig(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {noSignatureOffered(step) && !confirmNoSig && (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-[15px] text-muted-foreground">{NO_SIGNATURE_PROMPT}</span>
              <Button
                variant="outline"
                className="h-11 shrink-0 rounded-xl px-4 text-[15px]"
                disabled={busy || pending || sigUnknown}
                onClick={() => {
                  setMessage(null);
                  setConfirmNoSig(true);
                }}
              >
                {NO_SIGNATURE_ACTION}
              </Button>
            </div>
          )}
        </div>
    </TechSheet>
  );
}
