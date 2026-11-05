'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { saveErrorMessage } from '@/lib/admin/customer-validation';

const SAVE_FAILED = "Couldn't save the follow-up. Please try again.";
import { useAdminTechnicians } from '@/hooks/use-admin-technicians';

const UNASSIGNED = 'unassigned';

interface FollowUpFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customerId: string;
  readonly onSuccess: () => void;
}

export function FollowUpFormDialog({
  open,
  onOpenChange,
  customerId,
  onSuccess,
}: FollowUpFormDialogProps) {
  const { technicians } = useAdminTechnicians();
  const [reason, setReason] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState(UNASSIGNED);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignItems = [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...technicians
      .filter((t) => t.isActive)
      .map((t) => ({ value: t.id, label: t.name })),
  ];

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!reason.trim()) {
        setError('Add a reason for the follow-up.');
        return;
      }
      if (!dueDate) {
        setError('Pick a due date.');
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const res = await fetch(`/api/admin/customers/${customerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add_follow_up',
            reason: reason.trim(),
            dueDate,
            assignedTo: assignedTo === UNASSIGNED ? undefined : assignedTo,
          }),
        });

        const json = await res.json().catch(() => ({ success: false }));
        if (res.ok && json.success) {
          setReason('');
          setDueDate('');
          setAssignedTo(UNASSIGNED);
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
    [customerId, reason, dueDate, assignedTo, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule follow-up</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="follow-up-reason">Reason *</Label>
            <Input
              id="follow-up-reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              placeholder="Annual maintenance check"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="follow-up-due">Due date *</Label>
            <Input
              id="follow-up-due"
              type="date"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setError(null);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>Assign to</Label>
            <Select
              items={assignItems}
              value={assignedTo}
              onValueChange={(v) => setAssignedTo(v ?? UNASSIGNED)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignItems.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
