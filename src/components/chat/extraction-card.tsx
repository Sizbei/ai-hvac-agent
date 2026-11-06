'use client';

import { useState } from 'react';
import {
  sentenceCase,
  urgencyLabel,
  compactSummary,
  ISSUE_TYPE_OPTIONS,
} from '@/lib/chat/summary-labels';
import { motion } from 'motion/react';
import { ClipboardCheck, Pencil, Check, X, ChevronDown } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { SKIP_SENTINEL } from '@/lib/ai/chat-slots';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

interface ExtractionCardProps {
  readonly extraction: ExtractionResult;
  /** Called with the (possibly inline-edited) extraction data to open the dialog. */
  readonly onConfirm: (edited: ExtractionResult) => void;
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
            className="h-11 text-sm py-0 flex-1"
          />
          <button
            type="button"
            onClick={commitEdit}
            className="relative before:absolute before:-inset-2 before:content-[''] p-1 rounded-sm text-success hover:bg-success-light"
            aria-label={`Save ${label}`}
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            className="relative before:absolute before:-inset-2 before:content-[''] p-1 rounded-sm text-muted-foreground hover:bg-muted"
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
            className="relative before:absolute before:-inset-2 before:content-[''] p-0.5 rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity hover:bg-muted"
            aria-label={`Edit ${label}`}
          >
            <Pencil className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}

interface IssueTypeRowProps {
  readonly value: string;
  readonly onSave: (next: string) => void;
}

/** Issue type with an Edit that reopens it as a picker (round-2 UX N-P0-1). */
function IssueTypeRow({ value, onSave }: IssueTypeRowProps) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">Issue type</span>
      {editing ? (
        <select
          autoFocus
          aria-label="Issue type"
          value={value}
          onChange={(e) => {
            onSave(e.target.value);
            setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          className="h-11 rounded-md border border-border-input bg-surface-raised px-2 text-base text-foreground md:text-sm"
        >
          {ISSUE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{sentenceCase(value)}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="relative before:absolute before:-inset-2 before:content-[''] inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            aria-label="Edit issue type"
          >
            <Pencil className="size-3" />
            Edit
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
  // Phones show a one-line summary until opened, so the card doesn't bury the
  // transcript (it took ~520 of 844 px). From sm up it's always open.
  const [expanded, setExpanded] = useState(false);

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
            <ClipboardCheck className="size-4 text-marker" />
            Service request summary
          </CardTitle>
          {!expanded && (
            <p className="text-sm text-muted-foreground sm:hidden">
              {compactSummary({ issueType, urgency, address })}
            </p>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex min-h-11 items-center gap-1 self-start justify-self-start text-sm font-medium text-foreground underline-offset-4 hover:underline sm:hidden"
          >
            {expanded ? 'Hide details' : 'Review details'}
            <ChevronDown
              className={cn('size-4 transition-transform', expanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        </CardHeader>
        <CardContent
          className={cn(
            'gap-3',
            expanded ? 'grid max-h-[40dvh] overflow-y-auto sm:max-h-none' : 'hidden sm:grid',
          )}
        >
          {issueType && (
            <IssueTypeRow value={issueType} onSave={save('issueType')} />
          )}
          {urgency && (
            <FieldRow label="Urgency">
              <Badge variant={getUrgencyVariant(urgency)}>
                {urgencyLabel(urgency)}
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
          <Button onClick={() => onConfirm({ ...extraction, ...edits })} className="h-11 w-full text-sm">
            Confirm &amp; Submit
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}
