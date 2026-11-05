'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCentsExact } from '@/lib/admin/money-format';

export interface ApproveOption {
  readonly id: string;
  readonly name: string;
  readonly totalCents: number;
}

interface ApproveFormProps {
  readonly token: string;
  readonly options: readonly ApproveOption[];
}

/**
 * Public e-sign form: pick an option, type a name, POST to /api/estimates/approve.
 * On success it swaps to a confirmation; the page itself is token-gated, not
 * session-gated.
 */
// A typed signature needs at least this many letters (one stray key isn't one).
const MIN_SIGNATURE_LENGTH = 2;

export function ApproveForm({ token, options }: ApproveFormProps) {
  // Pre-select only when there is a single option: with several, the customer
  // must choose deliberately (a pre-selected cheapest option got approved by accident).
  const [optionId, setOptionId] = useState<string>(
    options.length === 1 ? (options[0]?.id ?? '') : '',
  );
  const [signatureName, setSignatureName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const signatureOk = signatureName.trim().length >= MIN_SIGNATURE_LENGTH;
  const chosen = options.find((o) => o.id === optionId) ?? null;

  async function handleSubmit(): Promise<void> {
    if (!optionId || !signatureOk) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/estimates/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          optionId,
          signatureName: signatureName.trim(),
        }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setDone(true);
      } else {
        // Only these codes carry customer-ready copy; anything else gets one
        // human sentence instead of server text.
        const code = body.error?.code;
        setError(
          (code === 'EXPIRED' || code === 'ALREADY_DECIDED') && body.error?.message
            ? `${body.error.message}. Reload the page to see the details.`
            : "Couldn't approve this estimate. Please try again, or contact us.",
        );
      }
    } catch {
      setError('Could not connect to the server. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-success-border bg-success-light p-6 text-center">
        <p className="text-[17px] font-semibold text-success-strong">
          Thank you — your approval is signed.
        </p>
        <p className="mt-1 text-[15px] text-foreground">
          {chosen
            ? `You approved ${chosen.name} for ${formatCentsExact(chosen.totalCents)}. `
            : ''}
          We&apos;ll be in touch to schedule the work. You can reopen this link
          any time to see what you approved.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="text-[15px] font-semibold text-foreground">
          Choose your option
        </legend>
        {options.map((opt) => (
          <label
            key={opt.id}
            className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border p-4 transition-colors duration-[var(--dur-hover)] ${
              optionId === opt.id
                ? 'border-marker bg-primary-soft'
                : 'border-border-strong hover:border-border-input'
            }`}
          >
            <span className="flex items-center gap-3">
              {/* radio glyph — a listed circular exemption */}
              <input
                type="radio"
                name="estimate-option"
                value={opt.id}
                checked={optionId === opt.id}
                onChange={() => setOptionId(opt.id)}
                className="size-4 accent-[var(--marker)]"
              />
              <span className="text-[15px] font-medium text-foreground">
                {opt.name}
              </span>
            </span>
            <span className="font-mono text-[17px] font-medium tabular-nums text-foreground">
              {formatCentsExact(opt.totalCents)}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="signature" className="text-[13px]">
          Type your full name to sign
        </Label>
        <Input
          id="signature"
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          placeholder="Your full name"
          maxLength={200}
          autoComplete="name"
          className="h-11 rounded-xl text-[15px] md:text-[15px]"
        />
        <p className="text-[13px] text-muted-foreground">
          By typing your name and approving, you authorize the selected work.
        </p>
      </div>

      {error && <p className="text-[15px] text-danger-strong">{error}</p>}

      <Button
        className="h-11 w-full rounded-xl text-[15px]"
        disabled={isSubmitting || !optionId || !signatureOk}
        onClick={handleSubmit}
      >
        {isSubmitting ? 'Submitting…' : 'Approve & sign'}
      </Button>
    </div>
  );
}
