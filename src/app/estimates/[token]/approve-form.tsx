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
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
        <p className="text-lg font-semibold text-green-800">
          Thank you — your approval is signed.
        </p>
        <p className="mt-1 text-sm text-green-700">
          We&apos;ve recorded your selection and will be in touch shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-gray-900">
          Choose your option
        </legend>
        {options.map((opt) => (
          <label
            key={opt.id}
            className={`flex cursor-pointer items-center justify-between rounded-lg border p-4 transition-colors ${
              optionId === opt.id
                ? 'border-gray-900 bg-gray-50'
                : 'border-gray-200 hover:border-gray-400'
            }`}
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="estimate-option"
                value={opt.id}
                checked={optionId === opt.id}
                onChange={() => setOptionId(opt.id)}
                className="size-4"
              />
              <span className="font-medium text-gray-900">{opt.name}</span>
            </span>
            <span className="font-semibold text-gray-900">
              {formatCentsExact(opt.totalCents)}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="signature">Type your full name to sign</Label>
        <Input
          id="signature"
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          placeholder="Your full name"
          maxLength={200}
          autoComplete="name"
        />
        <p className="text-xs text-gray-500">
          By typing your name and approving, you authorize the selected work.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button
        className="w-full"
        disabled={isSubmitting || !optionId || !signatureName.trim()}
        onClick={handleSubmit}
      >
        {isSubmitting ? 'Submitting…' : 'Approve & sign'}
      </Button>
    </div>
  );
}
