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
            We&apos;ll flag this conversation for a human. For an emergency, call
            us now — otherwise a technician will reach out within 2 hours.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
          <Phone className="size-4 text-muted-foreground" />
          <a href="tel:+15551234567" className="text-sm font-medium hover:underline">
            (555) 123-4567
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
