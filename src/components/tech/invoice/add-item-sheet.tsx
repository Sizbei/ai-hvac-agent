'use client';

import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { WriteResult } from './use-invoice-writes';

export interface PricebookHit {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly priceCents: number;
  readonly sku: string | null;
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;
const MAX_QTY = 999;
const clampQty = (n: number) => Math.min(MAX_QTY, Math.max(1, Math.trunc(n) || 1));

/**
 * "Add item" bottom sheet: pricebook search (≥ 2 chars, 300 ms debounce),
 * 44 px result rows with price, a 1–999 quantity stepper, and "Add", which
 * keeps the sheet open for the next item. A dropped intent (the refetch showed
 * the line already landed) closes it.
 */
export function AddItemSheet({
  open,
  onClose,
  onAdd,
  disabled,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdd: (item: PricebookHit, quantity: number) => Promise<WriteResult>;
  readonly disabled: boolean;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<readonly PricebookHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PricebookHit | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_CHARS) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/tech/pricebook?scope=invoice&q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.success) {
          setHits(body.data.items as PricebookHit[]);
          setSearchError(null);
        } else {
          setSearchError("Couldn't search the price book. Try again.");
        }
      } catch {
        if (!ctrl.signal.aborted) setSearchError("Couldn't search the price book. Try again.");
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  function changeQuery(v: string): void {
    setQ(v);
    if (v.trim().length < MIN_CHARS) setHits([]);
  }

  function reset(): void {
    setQ('');
    setHits([]);
    setPicked(null);
    setQty(1);
    setMessage(null);
    setSearchError(null);
  }

  async function add(): Promise<void> {
    if (!picked) return;
    setAdding(true);
    setMessage(null);
    const r = await onAdd(picked, qty);
    setAdding(false);
    if (r.status === 'done') {
      setMessage({ text: `Added ${picked.name}.`, error: false });
      setPicked(null);
      setQty(1);
    } else if (r.status === 'dropped') {
      reset();
      onClose();
    } else if (r.message) {
      setMessage({ text: r.message, error: true });
    }
  }

  const locked = disabled || adding;
  const short = q.trim().length < MIN_CHARS;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o && !adding) { reset(); onClose(); } }}>
      <SheetContent side="bottom" className="max-h-[88dvh] gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[17px]">Add item</SheetTitle>
          <SheetDescription className="text-[15px]">Search the price book by name or SKU.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-3 px-4">
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">Search</span>
            <Input
              type="search"
              value={q}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="Filter, capacitor, SKU…"
              className="h-11 rounded-xl text-[16px]"
              autoComplete="off"
            />
          </label>

          {picked ? (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-[15px] font-medium break-words">{picked.name}</p>
                <span className="shrink-0 font-mono text-[15px] tabular-nums">{formatCentsExact(picked.priceCents * qty)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" className="size-11 rounded-xl" aria-label="Less" disabled={qty <= 1 || locked} onClick={() => setQty((n) => clampQty(n - 1))}>
                  <Minus className="size-5" />
                </Button>
                <Input
                  inputMode="numeric"
                  aria-label="Quantity"
                  value={String(qty)}
                  onChange={(e) => setQty(clampQty(Number(e.target.value.replace(/\D/g, ''))))}
                  className="h-11 w-16 rounded-xl text-center font-mono text-[16px] tabular-nums"
                />
                <Button variant="outline" className="size-11 rounded-xl" aria-label="More" disabled={qty >= MAX_QTY || locked} onClick={() => setQty((n) => clampQty(n + 1))}>
                  <Plus className="size-5" />
                </Button>
                <Button variant="ghost" className="ml-auto h-11 rounded-xl px-3 text-[15px]" disabled={locked} onClick={() => setPicked(null)}>
                  Change
                </Button>
              </div>
              <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void add()}>
                {adding ? 'Adding…' : 'Add'}
              </Button>
            </div>
          ) : (
            <div className="min-h-0 overflow-y-auto">
              {short ? (
                <p className="py-2 text-[15px] text-muted-foreground">Type at least 2 letters.</p>
              ) : searching && hits.length === 0 ? (
                <p className="py-2 text-[15px] text-muted-foreground">Searching…</p>
              ) : hits.length === 0 && !searchError ? (
                <p className="py-2 text-[15px] text-muted-foreground">No matches. Try another name or SKU.</p>
              ) : (
                <ul className="divide-y divide-border" aria-label="Price book matches">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center gap-3 py-2 text-left active:bg-accent"
                        onClick={() => { setPicked(h); setQty(1); setMessage(null); }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] break-words">{h.name}</span>
                          {h.sku && <span className="block font-mono text-[13px] text-muted-foreground">{h.sku}</span>}
                        </span>
                        <span className="shrink-0 font-mono text-[15px] tabular-nums">{formatCentsExact(h.priceCents)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {searchError && <p role="alert" className="text-[13px] text-danger-strong">{searchError}</p>}
          {message && (
            <p role={message.error ? 'alert' : 'status'} className={`text-[13px] ${message.error ? 'text-danger-strong' : 'text-success-strong'}`}>
              {message.text}
            </p>
          )}
          <Button variant="outline" className="h-12 w-full rounded-xl text-[16px]" disabled={adding} onClick={() => { reset(); onClose(); }}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
