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
export function ApproveForm({ token, options }: ApproveFormProps) {
  const [optionId, setOptionId] = useState<string>(options[0]?.id ?? '');
  const [signatureName, setSignatureName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (!optionId || !signatureName.trim()) return;
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
        setError(body.error?.message ?? 'Could not approve this estimate.');
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
          We&apos;ve recorded your selection and will be in touch shortly.
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
        disabled={isSubmitting || !optionId || !signatureName.trim()}
        onClick={handleSubmit}
      >
        {isSubmitting ? 'Submitting…' : 'Approve & sign'}
      </Button>
    </div>
  );
}
