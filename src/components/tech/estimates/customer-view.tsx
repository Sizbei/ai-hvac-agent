'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCentsExact } from '@/lib/admin/money-format';
import { approveBlockedHint } from '@/lib/portal/estimate-decision';
import { MAX_SIGNATURE, signatureNameOk } from '@/lib/tech/estimate-input';
import {
  CUSTOMER_COPY, approveConfirmCopy, customerHeading, footerSummary, initialChoice, previewLines, showAllLabel,
} from '@/lib/tech/estimate-page-copy';
import type { TechEstimate } from '@/lib/tech/estimate-view';

type Screen = 'choose' | 'confirm' | 'sending' | 'checking' | 'success' | 'failed' | 'handback';

const MONEY = 'font-mono tabular-nums';

function Total({ label, cents, strong = false }: { readonly label: string; readonly cents: number; readonly strong?: boolean }) {
  return (
    <span className={`flex items-baseline justify-between gap-3 ${strong ? 'text-[17px] font-semibold' : 'text-[15px] text-muted-foreground'}`}>
      <span>{label}</span>
      <span className={MONEY}>{formatCentsExact(cents)}</span>
    </span>
  );
}

/**
 * The full-screen customer layer (M3c spec §7.2): opaque over the technician
 * header, Guide, Sign out and location card; pick an option, type a name,
 * approve, hand back. Shows no server text.
 */
export function CustomerView({
  estimate,
  companyName,
  customerDisplayName,
  onApprove,
  onClose,
}: {
  readonly estimate: TechEstimate;
  readonly companyName: string | null;
  readonly customerDisplayName: string | null;
  readonly onApprove: (optionId: string, signatureName: string, onChecking: () => void) => Promise<'success' | 'failed'>;
  readonly onClose: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(() => initialChoice(estimate.options));
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [screen, setScreen] = useState<Screen>('choose');
  const [typing, setTyping] = useState(false);
  const chosen = estimate.options.find((o) => o.id === choice) ?? null;
  const nameOk = signatureNameOk(name);
  const hint = approveBlockedHint(chosen !== null, nameOk);
  const sending = screen === 'sending' || screen === 'checking';
  const choosing = screen === 'choose';

  async function confirm(): Promise<void> {
    if (!chosen || !nameOk || sending) return;
    setScreen('sending');
    setScreen(await onApprove(chosen.id, name.trim(), () => setScreen('checking')));
  }

  const layer = (children: ReactNode) => (
    <div role="dialog" aria-modal="true" aria-label={customerHeading(customerDisplayName)} className="fixed inset-0 z-50 bg-canvas">
      <div className="mx-auto flex h-dvh w-full max-w-md flex-col">{children}</div>
    </div>
  );

  const endScreen = (text: string, action: string) => layer(
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <p role="status" className="text-[20px] font-semibold">{text}</p>
      <Button className="h-12 w-full rounded-xl text-[16px]" onClick={onClose}>{action}</Button>
    </div>,
  );

  if (screen === 'success') return endScreen(CUSTOMER_COPY.approved, CUSTOMER_COPY.handBack);
  if (screen === 'failed') return endScreen(CUSTOMER_COPY.failed, CUSTOMER_COPY.handBack);
  if (screen === 'handback') return endScreen(CUSTOMER_COPY.handBackPrompt, CUSTOMER_COPY.imTech);

  return layer(
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          {companyName && <p className="truncate text-[13px] text-muted-foreground">{companyName}</p>}
          <h2 className="text-[20px] font-semibold tracking-tight">{customerHeading(customerDisplayName)}</h2>
        </div>
        <Button variant="ghost" className="h-11 shrink-0 rounded-xl px-3 text-[15px]" disabled={sending} onClick={() => setScreen('handback')}>
          {CUSTOMER_COPY.notNow}
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <h3 className="text-[17px] font-semibold">{CUSTOMER_COPY.choose}</h3>
        <div role="radiogroup" aria-label={CUSTOMER_COPY.choose} className="space-y-3">
          {estimate.options.map((o) => {
            const selected = o.id === choice;
            const open = expanded.has(o.id);
            const more = showAllLabel(o.lines.length);
            return (
              <div key={o.id} className={`rounded-xl border bg-surface ${selected ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
                <label className="flex cursor-pointer gap-3 p-4">
                  <input
                    type="radio"
                    name="estimate-option"
                    value={o.id}
                    checked={selected}
                    disabled={!choosing}
                    onChange={() => setChoice(o.id)}
                    className="mt-1 size-5 shrink-0 accent-primary"
                  />
                  <span className="block min-w-0 flex-1 space-y-2">
                    <span className="block text-[17px] font-semibold">{o.name}</span>
                    <span className="block space-y-1">
                      {previewLines(o.lines, open).map((l) => (
                        <span key={l.id} className="flex items-baseline justify-between gap-3 text-[15px]">
                          <span className="min-w-0 break-words">{l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name}</span>
                          <span className={MONEY}>{formatCentsExact(l.lineTotalCents)}</span>
                        </span>
                      ))}
                    </span>
                    <span className="block space-y-0.5 border-t border-border pt-2">
                      <Total label="Subtotal" cents={o.subtotalCents} />
                      <Total label="Tax" cents={o.taxCents} />
                      <Total label="Total" cents={o.totalCents} strong />
                    </span>
                  </span>
                </label>
                {more && !open && (
                  <button
                    type="button"
                    className="min-h-11 w-full border-t border-border px-4 text-left text-[15px] text-link"
                    onClick={() => setExpanded((prev) => new Set(prev).add(o.id))}
                  >
                    {more}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <label className="block space-y-1.5 pt-2">
          <span className="text-[15px] font-medium">{CUSTOMER_COPY.nameLabel}</span>
          <Input
            value={name}
            maxLength={MAX_SIGNATURE}
            autoComplete="name"
            autoCapitalize="words"
            disabled={!choosing}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            className="h-12 rounded-xl text-[17px]"
          />
        </label>
        <p className="text-[13px] text-muted-foreground">{CUSTOMER_COPY.consent}</p>
        {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      </div>

      {!typing && (
        <div className="border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {choosing ? (
            <div className="flex items-center gap-3">
              <p className={`min-w-0 flex-1 truncate text-[15px] ${MONEY}`}>{footerSummary(chosen)}</p>
              <Button className="h-12 rounded-xl px-6 text-[16px]" disabled={!chosen || !nameOk} onClick={() => setScreen('confirm')}>
                {CUSTOMER_COPY.approve}
              </Button>
            </div>
          ) : screen === 'checking' ? (
            <p role="status" className="py-3 text-center text-[15px]">{CUSTOMER_COPY.checking}</p>
          ) : chosen ? (
            <div className="space-y-3">
              <p className="text-[17px] font-semibold">{approveConfirmCopy(chosen.name, chosen.totalCents)}</p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-12 flex-1 rounded-xl text-[16px]" disabled={sending} onClick={() => setScreen('choose')}>
                  {CUSTOMER_COPY.goBack}
                </Button>
                <Button className="h-12 flex-1 rounded-xl text-[16px]" disabled={sending} onClick={() => void confirm()}>
                  {screen === 'sending' ? CUSTOMER_COPY.approving : CUSTOMER_COPY.approve}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>,
  );
}
