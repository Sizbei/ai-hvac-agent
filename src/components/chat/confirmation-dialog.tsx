'use client';

import { useState } from 'react';
import { Loader2, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SKIP_SENTINEL } from '@/lib/ai/chat-slots';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly extraction: ExtractionResult;
  /** Called with the (possibly edited) extraction data on confirm. */
  readonly onConfirm: (edited: ExtractionResult) => void;
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

/** A single editable field row in the confirmation dialog. */
interface EditableRowProps {
  readonly label: string;
  readonly value: string;
  readonly onSave: (next: string) => void;
  readonly disabled?: boolean;
  /** When true the field is rendered as a non-editable badge (urgency). */
  readonly badge?: boolean;
}

function EditableRow({ label, value, onSave, disabled, badge }: EditableRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEdit() {
    setDraft(value);
    setEditing(true);
  }

  function commitEdit() {
    const trimmed = draft.trim();
    if (trimmed) onSave(trimmed);
    setEditing(false);
  }

  function cancelEdit() {
    setDraft(value);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }

  if (badge) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-sm">
          <Badge variant={getUrgencyVariant(value)}>
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </Badge>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 text-sm py-0 flex-1"
            disabled={disabled}
          />
          <button
            type="button"
            onClick={commitEdit}
            className="p-1 rounded-sm text-green-600 hover:bg-green-50"
            aria-label={`Save ${label}`}
            disabled={disabled}
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            className="p-1 rounded-sm text-muted-foreground hover:bg-muted"
            aria-label={`Cancel editing ${label}`}
            disabled={disabled}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 group">
          <span className="text-sm">{value}</span>
          <button
            type="button"
            onClick={startEdit}
            className="p-0.5 rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-muted"
            aria-label={`Edit ${label}`}
            disabled={disabled}
          >
            <Pencil className="size-3" />
          </button>
        </div>
      )}
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
  // Local editable copy so corrections don't affect hook state until confirmed.
  const [edits, setEdits] = useState<Partial<ExtractionResult>>({});

  // Reset edits when the dialog opens with fresh extraction data.
  const [lastExtraction, setLastExtraction] = useState(extraction);
  if (extraction !== lastExtraction) {
    setLastExtraction(extraction);
    setEdits({});
  }

  function field<K extends keyof ExtractionResult>(key: K): ExtractionResult[K] {
    return (key in edits ? edits[key] : extraction[key]) as ExtractionResult[K];
  }

  function save<K extends keyof ExtractionResult>(key: K) {
    return (val: string) => setEdits((prev) => ({ ...prev, [key]: val }));
  }

  function handleConfirm() {
    // Merge edits on top of original extraction before submitting.
    onConfirm({ ...extraction, ...edits });
  }

  const issueType = field('issueType');
  const urgency = field('urgency');
  const address = field('address');
  const customerName = field('customerName');
  const customerPhone = field('customerPhone');
  const customerEmail = field('customerEmail');
  const description = field('description');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm your service request</DialogTitle>
          <DialogDescription>
            Review your details below. Tap the pencil icon to correct anything before submitting.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {issueType && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Issue type</span>
              <span className="text-sm">{formatSnakeCase(issueType)}</span>
            </div>
          )}
          {urgency && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Urgency</span>
              <Badge variant={getUrgencyVariant(urgency)} className="w-fit">
                {urgency.charAt(0).toUpperCase() + urgency.slice(1)}
              </Badge>
            </div>
          )}
          {address && (
            <EditableRow
              label="Address"
              value={address}
              onSave={save('address')}
              disabled={isLoading}
            />
          )}
          {customerName && (
            <EditableRow
              label="Name"
              value={customerName}
              onSave={save('customerName')}
              disabled={isLoading}
            />
          )}
          {customerPhone && (
            <EditableRow
              label="Phone"
              value={customerPhone}
              onSave={save('customerPhone')}
              disabled={isLoading}
            />
          )}
          {customerEmail && customerEmail !== SKIP_SENTINEL && (
            <EditableRow
              label="Email"
              value={customerEmail}
              onSave={save('customerEmail')}
              disabled={isLoading}
            />
          )}
          {customerEmail === SKIP_SENTINEL && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Email</span>
              <span className="text-sm text-muted-foreground">Not provided</span>
            </div>
          )}
          {description && (
            <EditableRow
              label="Description"
              value={description}
              onSave={save('description')}
              disabled={isLoading}
            />
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
            Go back
          </Button>
          <Button onClick={handleConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Confirm &amp; Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
