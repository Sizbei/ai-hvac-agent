'use client';

import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { SheetNote } from '@/lib/tech/sheet-note';

/**
 * The tech invoice bottom-sheet shell: title, description, safe-area padding,
 * and a close that is refused while the sheet's write is in flight.
 */
export function TechSheet({
  open,
  onClose,
  busy,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[92dvh] gap-3 overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="pr-12">
          <SheetTitle className="text-[17px]">{title}</SheetTitle>
          <SheetDescription className="text-[15px]">{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** An alert (error) or status line; `success` colours a status line green. */
export function NoteLine({ note, success = false }: { readonly note: SheetNote | null; readonly success?: boolean }) {
  if (!note) return null;
  const tone = note.error ? 'text-danger-strong' : success ? 'text-success-strong' : 'text-muted-foreground';
  return (
    <p role={note.error ? 'alert' : 'status'} className={`text-[15px] ${tone}`}>
      {note.text}
    </p>
  );
}
