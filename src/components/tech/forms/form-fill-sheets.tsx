'use client';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/** The fill page's two confirms (M3d spec §7.3): Submit and Clear answers. */
export function FillConfirmSheet({
  open, onOpenChange, title, description, confirmLabel, onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader>
          <SheetTitle className="text-[17px]">{title}</SheetTitle>
          {description && <SheetDescription className="text-[15px]">{description}</SheetDescription>}
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4">
          <Button className="h-12 rounded-xl text-[16px]" onClick={onConfirm}>{confirmLabel}</Button>
          <Button variant="outline" className="h-12 rounded-xl text-[16px]" onClick={() => onOpenChange(false)}>Go back</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
