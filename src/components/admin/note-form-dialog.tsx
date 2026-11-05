'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NOTE_TYPE_OPTIONS } from '@/lib/admin/display-labels';
import { saveErrorMessage } from '@/lib/admin/customer-validation';

const SAVE_FAILED = "Couldn't save the note. Please try again.";

interface NoteFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customerId: string;
  readonly onSuccess: () => void;
}

export function NoteFormDialog({
  open,
  onOpenChange,
  customerId,
  onSuccess,
}: NoteFormDialogProps) {
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState('general');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!content.trim()) {
        setError('Write the note before saving.');
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const res = await fetch(`/api/admin/customers/${customerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add_note',
            content: content.trim(),
            noteType,
          }),
        });

        const json = await res.json().catch(() => null);
        if (res.ok && json?.success) {
          setContent('');
          setNoteType('general');
          onSuccess();
        } else {
          setError(saveErrorMessage(res.status, json, SAVE_FAILED));
        }
      } catch {
        setError(SAVE_FAILED);
      } finally {
        setIsSubmitting(false);
      }
    },
    [customerId, content, noteType, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add note</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              items={NOTE_TYPE_OPTIONS}
              value={noteType}
              onValueChange={(v) => setNoteType(v ?? 'general')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTE_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="note-content">Note *</Label>
            <textarea
              id="note-content"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setError(null);
              }}
              placeholder="Enter note…"
              rows={4}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
