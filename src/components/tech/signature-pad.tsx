'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface SignaturePadProps {
  /** Called with the SAME Blob on every retry of one intent; a redraw, Clear or
   * a name edit drops it, so the next tap captures a new one (and the parent's
   * key reducer mints a new key when it sees it). */
  readonly onCapture: (blob: Blob, name: string) => Promise<void>;
  readonly disabled?: boolean;
  readonly initialName?: string;
  /** Inline error from the parent (the write's outcome). */
  readonly error?: string;
}

const CANVAS_W = 320;
const CANVAS_H = 140;

/** Typed-name fallback rendered on an offscreen canvas, so the visible pad is
 * never painted over (a later name edit would otherwise stack two names). */
function typedNameCanvas(name: string): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = CANVAS_W;
  off.height = CANVAS_H;
  const ctx = off.getContext('2d');
  if (ctx) {
    ctx.font = '28px cursive';
    ctx.fillStyle = '#111';
    ctx.fillText(name, 16, CANVAS_H / 2 + 10);
  }
  return off;
}

/** Customer signature: pointer-drawn canvas + printed name. Captures the PNG
 * once per intent and holds it until a redraw, Clear or name edit. */
export function SignaturePad({ onCapture, disabled = false, initialName = '', error }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const [name, setName] = useState(initialName);
  const [held, setHeld] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous guard: a double-tap lands before the `busy` re-render.
  const busyRef = useRef(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const locked = disabled || busy;

  const getCtx = () => canvasRef.current?.getContext('2d') ?? null;

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // The canvas renders w-full over a fixed 320x140 backing store: map the
    // CSS-pixel pointer into backing-store coordinates.
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (locked) return;
    const ctx = getCtx();
    if (!ctx) return;
    drawingRef.current = true;
    hasDrawnRef.current = true;
    setHeld(null);
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
    setHeld(null);
  };

  const capture = async (trimmed: string): Promise<Blob | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const source = hasDrawnRef.current ? canvas : typedNameCanvas(trimmed);
    return new Promise<Blob | null>((resolve) => source.toBlob((b) => resolve(b), 'image/png'));
  };

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busyRef.current) return;
    // Busy BEFORE the capture, so a tap during toBlob cannot call onCapture twice.
    busyRef.current = true;
    setBusy(true);
    setCaptureError(null);
    try {
      let blob = held;
      if (!blob) {
        blob = await capture(trimmed);
        if (!blob) {
          setCaptureError("Couldn't capture the signature. Try again.");
          return;
        }
        setHeld(blob);
      }
      await onCapture(blob, trimmed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const shownError = captureError ?? error;

  return (
    <div className="space-y-3">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        aria-label="Signature area. Draw with a finger."
        onPointerDown={startDraw}
        onPointerMove={moveDraw}
        onPointerUp={endDraw}
        onPointerLeave={endDraw}
        className={`w-full touch-none rounded-xl border border-border-strong bg-surface-raised ${locked ? 'opacity-60' : ''}`}
      />
      <div className="space-y-1.5">
        <Label htmlFor="signature-name" className="text-[13px]">
          Customer name
        </Label>
        <Input
          id="signature-name"
          value={name}
          disabled={locked}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setHeld(null);
          }}
          className="h-11 rounded-xl text-[15px] md:text-[15px]"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="h-12 flex-1 rounded-xl px-4 text-[15px]"
          disabled={locked || !name.trim()}
          onClick={() => void handleSave()}
        >
          {busy ? 'Saving…' : 'Save signature'}
        </Button>
        <Button className="h-12 rounded-xl px-4 text-[15px]" variant="ghost" disabled={locked} onClick={clearCanvas}>
          Clear
        </Button>
      </div>
      {shownError && (
        <p role="alert" className="text-[13px] text-danger-strong">
          {shownError}
        </p>
      )}
    </div>
  );
}
