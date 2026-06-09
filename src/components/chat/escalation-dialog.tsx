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
}

export function EscalationDialog({
  open,
  onOpenChange,
  onConfirm,
  isLoading = false,
}: EscalationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Talk to a Human</DialogTitle>
          <DialogDescription>
            We&apos;ll flag this conversation for a human, who will reach out to
            confirm the details. For an emergency, call us any time, day or
            night.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
          <Phone className="size-4 text-muted-foreground" />
          <a href="tel:+14238549505" className="text-sm font-medium hover:underline">
            423-854-9505
          </a>
        </div>
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
            Confirm Escalation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
