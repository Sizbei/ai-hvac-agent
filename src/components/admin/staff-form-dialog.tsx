'use client';

import { useState, useEffect } from 'react';
import type { StaffRecord } from '@/lib/admin/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface StaffFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  readonly staff: StaffRecord | null;
  /** True when editing your own account — disables role/active controls so you
   * can't lock yourself out. The server enforces this too. */
  readonly isSelf: boolean;
}

type Role = 'admin' | 'technician';

interface FormState {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: Role;
  readonly isActive: boolean;
}

const INITIAL_FORM_STATE: FormState = {
  name: '',
  email: '',
  password: '',
  role: 'technician',
  isActive: true,
};

function createFormState(staff: StaffRecord | null): FormState {
  if (!staff) return INITIAL_FORM_STATE;
  return {
    name: staff.name,
    email: staff.email,
    password: '',
    role: staff.role,
    isActive: staff.isActive,
  };
}

export function StaffFormDialog({
  open,
  onClose,
  onSuccess,
  staff,
  isSelf,
}: StaffFormDialogProps) {
  const isEditMode = staff !== null;
  const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(createFormState(staff));
      setError(null);
    }
  }, [open, staff]);

  function updateField<K extends keyof FormState>(
    field: K,
    value: FormState[K],
  ): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function validate(): string | null {
    if (!form.name.trim()) return 'Name is required';
    if (!isEditMode) {
      if (!form.email.trim()) return 'Email is required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
        return 'Please enter a valid email address';
      }
      if (form.password.length < 8) {
        return 'Password must be at least 8 characters';
      }
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
      const url =
        isEditMode && staff
          ? `/api/admin/staff/${staff.id}`
          : '/api/admin/staff';
      const method = isEditMode ? 'PATCH' : 'POST';

      // On edit, email is immutable here (changing it would require a contact
      // re-check + the user re-authenticating); we only patch name/role/active.
      // Send ONLY the fields that actually changed so the audit trail records a
      // faithful list of what was modified (a name-only edit logs just "name").
      let body: Record<string, unknown>;
      if (isEditMode && staff) {
        const patch: Record<string, unknown> = {};
        const trimmedName = form.name.trim();
        if (trimmedName !== staff.name) patch.name = trimmedName;
        if (form.role !== staff.role) patch.role = form.role;
        if (form.isActive !== staff.isActive) patch.isActive = form.isActive;

        if (Object.keys(patch).length === 0) {
          // Nothing changed — close without a no-op request.
          onSuccess();
          onClose();
          return;
        }
        body = patch;
      } else {
        body = {
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
        };
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(responseBody?.error?.message ?? 'Failed to save staff member');
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
            {isEditMode ? 'Edit Staff Member' : 'Add Staff Member'}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update name, role, and status.'
              : 'Create a new staff account (admin or technician).'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="staff-name">Name</Label>
            <Input
              id="staff-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Full name"
              required
            />
          </div>

          {!isEditMode && (
            <>
              <div className="space-y-2">
                <Label htmlFor="staff-email">Email</Label>
                <Input
                  id="staff-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  placeholder="person@example.com"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="staff-password">Password</Label>
                <Input
                  id="staff-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  placeholder="Min. 8 characters"
                  required
                  minLength={8}
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="staff-role">Role</Label>
            <Select
              value={form.role}
              onValueChange={(v) =>
                updateField('role', (v ?? 'technician') as Role)
              }
              disabled={isSelf}
            >
              <SelectTrigger id="staff-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="technician">Technician</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && (
              <p className="text-xs text-muted-foreground">
                You cannot change your own role.
              </p>
            )}
          </div>

          {isEditMode && (
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="staff-active">Active</Label>
                {isSelf && (
                  <p className="text-xs text-muted-foreground">
                    You cannot deactivate your own account.
                  </p>
                )}
              </div>
              <Switch
                id="staff-active"
                checked={form.isActive}
                onCheckedChange={(checked) => updateField('isActive', checked)}
                disabled={isSelf}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

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
