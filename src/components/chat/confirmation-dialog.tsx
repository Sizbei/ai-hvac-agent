'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly extraction: ExtractionResult;
  readonly onConfirm: () => void;
  readonly isLoading?: boolean;
}

function formatSnakeCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getUrgencyVariant(
  urgency: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (urgency) {
    case 'emergency':
    case 'high':
      return 'destructive';
    case 'medium':
      return 'outline';
    case 'low':
      return 'secondary';
    default:
      return 'secondary';
  }
}

interface DetailRowProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  extraction,
  onConfirm,
  isLoading = false,
}: ConfirmationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm Your Service Request</DialogTitle>
          <DialogDescription>
            Please review the details below before submitting.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {extraction.issueType && (
            <DetailRow label="Issue Type">
              {formatSnakeCase(extraction.issueType)}
            </DetailRow>
          )}
          {extraction.urgency && (
            <DetailRow label="Urgency">
              <Badge variant={getUrgencyVariant(extraction.urgency)}>
                {extraction.urgency.charAt(0).toUpperCase() +
                  extraction.urgency.slice(1)}
              </Badge>
            </DetailRow>
          )}
          {extraction.address && (
            <DetailRow label="Address">{extraction.address}</DetailRow>
          )}
          {extraction.customerName && (
            <DetailRow label="Name">{extraction.customerName}</DetailRow>
          )}
          {extraction.customerPhone && (
            <DetailRow label="Phone">{extraction.customerPhone}</DetailRow>
          )}
          {extraction.customerEmail && (
            <DetailRow label="Email">{extraction.customerEmail}</DetailRow>
          )}
          {extraction.description && (
            <DetailRow label="Description">
              {extraction.description}
            </DetailRow>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          By confirming, a service request will be created and a technician will
          be assigned.
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Go Back
          </Button>
          <Button onClick={onConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Confirm &amp; Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
