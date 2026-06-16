'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';

interface Material {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly unitPriceCents: number;
}

interface PricebookItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly priceCents: number;
}

export function TechJobDetailClient({ id }: { readonly id: string }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Material add form
  const [catalog, setCatalog] = useState<PricebookItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Note
  const [note, setNote] = useState('');
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const [isPostingNote, setIsPostingNote] = useState(false);

  // Signature
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const [sigName, setSigName] = useState('');
  const [sigStatus, setSigStatus] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);

  const loadMaterials = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${id}/materials`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) setMaterials(body.data.materials);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadMaterials();
  }, [loadMaterials]);

  // Load the pricebook once for catalog selection.
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/pricebook');
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) setCatalog(body.data.items);
    })();
  }, []);

  const handleAdd = useCallback(async (): Promise<void> => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setAddError('Quantity must be a whole number ≥ 1.');
      return;
    }
    if (!selectedItemId && !manualDesc.trim()) {
      setAddError('Pick a catalog item or enter a description.');
      return;
    }
    setIsAdding(true);
    setAddError(null);
    try {
      const payload = selectedItemId
        ? { pricebookItemId: selectedItemId, quantity: qty }
        : { description: manualDesc.trim(), quantity: qty };
      const res = await fetch(`/api/tech/jobs/${id}/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setSelectedItemId('');
        setManualDesc('');
        setQuantity('1');
        setSearch('');
        void loadMaterials();
      } else {
        setAddError(body.error?.message ?? 'Failed to add material');
      }
    } catch {
      setAddError('Could not connect to server.');
    } finally {
      setIsAdding(false);
    }
  }, [id, quantity, selectedItemId, manualDesc, loadMaterials]);

  const handleRemove = useCallback(
    async (materialId: string): Promise<void> => {
      const res = await fetch(
        `/api/tech/jobs/${id}/materials?materialId=${materialId}`,
        { method: 'DELETE' },
      );
      if (res.ok) void loadMaterials();
    },
    [id, loadMaterials],
  );

  const handlePostNote = useCallback(async (): Promise<void> => {
    if (!note.trim()) return;
    setIsPostingNote(true);
    setNoteStatus(null);
    try {
      const res = await fetch(`/api/tech/jobs/${id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: note.trim() }),
      });
      if (res.ok) {
        setNote('');
        setNoteStatus('Note saved.');
      } else {
        setNoteStatus('Failed to save note.');
      }
    } catch {
      setNoteStatus('Could not connect to server.');
    } finally {
      setIsPostingNote(false);
    }
  }, [id, note]);

  // ── Signature canvas (pointer-based; renders the typed-name fallback too) ──
  const getCtx = () => canvasRef.current?.getContext('2d') ?? null;

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = getCtx();
    if (!ctx) return;
    drawingRef.current = true;
    hasDrawnRef.current = true;
    const { x, y } = pointerPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const { x, y } = pointerPos(e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const endDraw = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawnRef.current = false;
  };

  const handleSign = useCallback(async (): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!sigName.trim()) {
      setSigStatus('Enter the customer name.');
      return;
    }
    // Typed-name fallback: if nothing was drawn, render the name onto the canvas
    // so we always submit a PNG.
    if (!hasDrawnRef.current) {
      const ctx = getCtx();
      if (ctx) {
        ctx.font = '28px cursive';
        ctx.fillStyle = '#111';
        ctx.fillText(sigName.trim(), 16, canvas.height / 2 + 10);
      }
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    );
    if (!blob) {
      setSigStatus('Could not capture signature.');
      return;
    }

    setIsSigning(true);
    setSigStatus(null);
    try {
      const form = new FormData();
      form.append('file', new File([blob], 'signature.png', { type: 'image/png' }));
      form.append('signatureName', sigName.trim());
      const res = await fetch(`/api/tech/jobs/${id}/signature`, {
        method: 'POST',
        body: form,
      });
      if (res.ok) {
        setSigStatus('Signature saved.');
        clearCanvas();
        setSigName('');
      } else {
        const body = await res.json().catch(() => ({}));
        setSigStatus(body.error?.message ?? 'Failed to save signature.');
      }
    } catch {
      setSigStatus('Could not connect to server.');
    } finally {
      setIsSigning(false);
    }
  }, [id, sigName]);

  const filteredCatalog = search.trim()
    ? catalog.filter((c) =>
        c.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : catalog;

  return (
    <div className="space-y-5">
      <Link
        href="/tech/jobs"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-4" /> Back
      </Link>

      {/* Materials used */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Materials used</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : materials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No materials recorded yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {materials.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {m.description ?? 'Material'}
                    {m.quantity > 1 ? ` × ${m.quantity}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">
                      {formatCentsExact(m.unitPriceCents * m.quantity)}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove material"
                      onClick={() => void handleRemove(m.id)}
                      className="text-muted-foreground active:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Add material */}
          <div className="space-y-2 border-t pt-3">
            <Input
              placeholder="Search pricebook…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              value={selectedItemId}
              onChange={(e) => {
                setSelectedItemId(e.target.value);
                if (e.target.value) setManualDesc('');
              }}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              <option value="">— Manual entry —</option>
              {filteredCatalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {!selectedItemId && (
              <Input
                placeholder="Manual description"
                value={manualDesc}
                onChange={(e) => setManualDesc(e.target.value)}
              />
            )}
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-20"
              />
              <Button
                size="sm"
                disabled={isAdding}
                onClick={() => void handleAdd()}
              >
                {isAdding ? 'Adding…' : 'Add'}
              </Button>
            </div>
            {addError && <p className="text-xs text-destructive">{addError}</p>}
          </div>
        </CardContent>
      </Card>

      {/* On-site note */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-site note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="What you found / did on-site…"
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <Button
            size="sm"
            disabled={isPostingNote || !note.trim()}
            onClick={() => void handlePostNote()}
          >
            {isPostingNote ? 'Saving…' : 'Save note'}
          </Button>
          {noteStatus && (
            <p className="text-xs text-muted-foreground">{noteStatus}</p>
          )}
        </CardContent>
      </Card>

      {/* Customer signature */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer signature</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <canvas
            ref={canvasRef}
            width={320}
            height={140}
            onPointerDown={startDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            onPointerLeave={endDraw}
            className="w-full touch-none rounded-md border bg-white"
          />
          <Input
            placeholder="Customer name"
            value={sigName}
            onChange={(e) => setSigName(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={isSigning || !sigName.trim()}
              onClick={() => void handleSign()}
            >
              {isSigning ? 'Saving…' : 'Save signature'}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearCanvas}>
              Clear
            </Button>
          </div>
          {sigStatus && (
            <p className="text-xs text-muted-foreground">{sigStatus}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
