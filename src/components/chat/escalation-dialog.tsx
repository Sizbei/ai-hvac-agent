'use client';

import { Phone, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface EscalationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly isLoading?: boolean;
  /** The org's phone as displayed, with its `tel:` href — omitted when the
   * org has none (never another company's number). */
  readonly phone?: string | null;
  readonly callHref?: string | null;
}

export function EscalationDialog({
  open,
  onOpenChange,
  onConfirm,
  isLoading = false,
  phone = null,
  callHref = null,
}: EscalationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Talk to a human</DialogTitle>
          <DialogDescription>
            We&apos;ll flag this conversation for a person on our team, who
            will reach out to confirm the details.
            {phone ? ' For an emergency, call us any time, day or night.' : ''}
          </DialogDescription>
        </DialogHeader>
        {phone && callHref && (
          <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
            <Phone className="size-4 text-muted-foreground" />
            <a href={callHref} className="text-sm font-medium hover:underline">
              {phone}
            </a>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Connect me
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
