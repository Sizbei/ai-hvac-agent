'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!reason.trim()) {
        setError('Reason is required');
        return;
      }
      if (!dueDate) {
        setError('Due date is required');
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
          setError(json.error?.message ?? 'Failed to add follow-up');
        }
      } catch {
        setError('Network error');
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
          <DialogTitle>Schedule Follow-up</DialogTitle>
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
              onChange={(e) => setReason(e.target.value)}
              placeholder="Annual maintenance check"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="follow-up-due">Due Date *</Label>
            <Input
              id="follow-up-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Assign To</Label>
            <Select
              value={assignedTo}
              onValueChange={(v) => setAssignedTo(v ?? UNASSIGNED)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {technicians
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
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
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
