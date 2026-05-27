'use client';

import { useState, useEffect } from 'react';
import type { TechnicianRecord } from '@/lib/admin/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface TechnicianFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  readonly technician: TechnicianRecord | null;
}

interface FormState {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly isActive: boolean;
}

const INITIAL_FORM_STATE: FormState = {
  name: '',
  email: '',
  password: '',
  isActive: true,
};

function createFormState(technician: TechnicianRecord | null): FormState {
  if (!technician) return INITIAL_FORM_STATE;
  return {
    name: technician.name,
    email: technician.email,
    password: '',
    isActive: technician.isActive,
  };
}

export function TechnicianFormDialog({
  open,
  onClose,
  onSuccess,
  technician,
}: TechnicianFormDialogProps) {
  const isEditMode = technician !== null;
  const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens or technician changes
  useEffect(() => {
    if (open) {
      setForm(createFormState(technician));
      setError(null);
    }
  }, [open, technician]);

  function updateField<K extends keyof FormState>(
    field: K,
    value: FormState[K],
  ): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function validate(): string | null {
    if (!form.name.trim()) return 'Name is required';
    if (!form.email.trim()) return 'Email is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      return 'Please enter a valid email address';
    }
    if (!isEditMode && form.password.length < 8) {
      return 'Password must be at least 8 characters';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const url = isEditMode
        ? `/api/admin/technicians/${technician.id}`
        : '/api/admin/technicians';

      const method = isEditMode ? 'PATCH' : 'POST';

      const body = isEditMode
        ? { name: form.name.trim(), email: form.email.trim(), isActive: form.isActive }
        : { name: form.name.trim(), email: form.email.trim(), password: form.password };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(responseBody?.error?.message ?? 'Failed to save technician');
        return;
      }

      onSuccess();
      onClose();
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? 'Edit Technician' : 'Add Technician'}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update technician details and status.'
              : 'Create a new technician account.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tech-name">Name</Label>
            <Input
              id="tech-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Full name"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tech-email">Email</Label>
            <Input
              id="tech-email"
              type="email"
              value={form.email}
              onChange={(e) => updateField('email', e.target.value)}
              placeholder="technician@example.com"
              required
            />
          </div>

          {!isEditMode && (
            <div className="space-y-2">
              <Label htmlFor="tech-password">Password</Label>
              <Input
                id="tech-password"
                type="password"
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                placeholder="Min. 8 characters"
                required
                minLength={8}
              />
            </div>
          )}

          {isEditMode && (
            <div className="flex items-center justify-between">
              <Label htmlFor="tech-active">Active</Label>
              <Switch
                id="tech-active"
                checked={form.isActive}
                onCheckedChange={(checked) => updateField('isActive', checked)}
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
