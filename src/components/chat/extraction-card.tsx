'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { ClipboardCheck, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { ANIMATION } from '@/lib/design-tokens';
import { SKIP_SENTINEL } from '@/lib/ai/chat-slots';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

interface ExtractionCardProps {
  readonly extraction: ExtractionResult;
  /** Called with the (possibly inline-edited) extraction data to open the dialog. */
  readonly onConfirm: (edited: ExtractionResult) => void;
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

interface EditableFieldRowProps {
  readonly label: string;
  readonly value: string;
  readonly onSave: (next: string) => void;
}

function EditableFieldRow({ label, value, onSave }: EditableFieldRowProps) {
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
          />
          <button
            type="button"
            onClick={commitEdit}
            className="p-1 rounded-sm text-green-600 hover:bg-green-50"
            aria-label={`Save ${label}`}
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            className="p-1 rounded-sm text-muted-foreground hover:bg-muted"
            aria-label={`Cancel editing ${label}`}
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
            className="p-0.5 rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity hover:bg-muted"
            aria-label={`Edit ${label}`}
          >
            <Pencil className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}

interface FieldRowProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function FieldRow({ label, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export function ExtractionCard({ extraction, onConfirm }: ExtractionCardProps) {
  // Local editable copy so inline corrections are applied before the dialog opens.
  const [edits, setEdits] = useState<Partial<ExtractionResult>>({});

  function field<K extends keyof ExtractionResult>(key: K): ExtractionResult[K] {
    return (key in edits ? edits[key] : extraction[key]) as ExtractionResult[K];
  }

  function save<K extends keyof ExtractionResult>(key: K) {
    return (val: string) => setEdits((prev) => ({ ...prev, [key]: val }));
  }

  const issueType = field('issueType');
  const urgency = field('urgency');
  const address = field('address');
  const customerName = field('customerName');
  const customerPhone = field('customerPhone');
  const customerEmail = field('customerEmail');
  const description = field('description');

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.cardFadeIn.duration,
        ease: ANIMATION.cardFadeIn.ease,
      }}
      className="flex justify-start"
    >
      <Card className="w-full max-w-[90%]" size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-primary" />
            Service request summary
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {issueType && (
            <FieldRow label="Issue type">
              {formatSnakeCase(issueType)}
            </FieldRow>
          )}
          {urgency && (
            <FieldRow label="Urgency">
              <Badge variant={getUrgencyVariant(urgency)}>
                {urgency.charAt(0).toUpperCase() + urgency.slice(1)}
              </Badge>
            </FieldRow>
          )}
          {address && (
            <EditableFieldRow
              label="Address"
              value={address}
              onSave={save('address')}
            />
          )}
          {customerName && (
            <EditableFieldRow
              label="Name"
              value={customerName}
              onSave={save('customerName')}
            />
          )}
          {customerPhone && (
            <EditableFieldRow
              label="Phone"
              value={customerPhone}
              onSave={save('customerPhone')}
            />
          )}
          {customerEmail && customerEmail !== SKIP_SENTINEL && (
            <EditableFieldRow
              label="Email"
              value={customerEmail}
              onSave={save('customerEmail')}
            />
          )}
          {customerEmail === SKIP_SENTINEL && (
            <FieldRow label="Email">
              <span className="text-muted-foreground">Not provided</span>
            </FieldRow>
          )}
          {description && (
            <EditableFieldRow
              label="Description"
              value={description}
              onSave={save('description')}
            />
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={() => onConfirm({ ...extraction, ...edits })} className="w-full">
            Confirm &amp; Submit
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}
