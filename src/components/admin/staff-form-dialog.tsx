'use client';

import { useState, useEffect, useRef } from 'react';
import type { StaffRecord, StaffRole } from '@/lib/admin/types';
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
  /** True when the current user is a super_admin. Gates the admin-tier role
   * options (Super Admin / Admin) in the dropdown — a normal admin may only
   * create/assign Technician. The server is the authoritative guard; this just
   * hides options the actor can't use. */
  readonly canManageAdmins?: boolean;
}

interface FormState {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: StaffRole;
  readonly isActive: boolean;
  /** Labor rate as a dollars string ('' = no rate set). */
  readonly laborRate: string;
}

const INITIAL_FORM_STATE: FormState = {
  name: '',
  email: '',
  password: '',
  role: 'technician',
  isActive: true,
  laborRate: '',
};

/** Integer cents → dollars string for the form ('' when null). */
function centsToDollars(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function createFormState(staff: StaffRecord | null): FormState {
  if (!staff) return INITIAL_FORM_STATE;
  return {
    name: staff.name,
    email: staff.email,
    password: '',
    role: staff.role,
    isActive: staff.isActive,
    laborRate: centsToDollars(staff.laborRateCents),
  };
}

export function StaffFormDialog({
  open,
  onClose,
  onSuccess,
  staff,
  isSelf,
  canManageAdmins = false,
}: StaffFormDialogProps) {
  const isEditMode = staff !== null;
  const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

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
    const rate = form.laborRate.trim();
    if (rate !== '') {
      const n = Number(rate);
      if (!Number.isFinite(n) || n < 0) {
        return 'Labor rate must be a non-negative dollar amount';
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

    // On edit, check for no-op before acquiring the submit lock so the
    // button doesn't stay stuck if we return early.
    if (isEditMode && staff) {
      const trimmedName = form.name.trim();
      const trimmedRate = form.laborRate.trim();
      const nextRateCents =
        trimmedRate === '' ? null : Math.round(Number(trimmedRate) * 100);
      const nothingChanged =
        trimmedName === staff.name &&
        form.role === staff.role &&
        form.isActive === staff.isActive &&
        nextRateCents === staff.laborRateCents;
      if (nothingChanged) {
        // Nothing changed — close without a no-op request.
        onSuccess();
        onClose();
        return;
      }
    }

    if (submittingRef.current) return;
    submittingRef.current = true;

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

        // Labor rate: dollars string → integer cents (empty clears it to null).
        // Only patch when it actually changed from the stored value.
        const trimmedRate = form.laborRate.trim();
        const nextRateCents =
          trimmedRate === '' ? null : Math.round(Number(trimmedRate) * 100);
        if (nextRateCents !== staff.laborRateCents) {
          patch.laborRateCents = nextRateCents;
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
      submittingRef.current = false;
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && submittingRef.current) return; if (!isOpen) onClose(); }}>
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
                updateField('role', (v ?? 'technician') as StaffRole)
              }
              disabled={isSelf}
            >
              <SelectTrigger id="staff-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {/* super_admin is DB/edit-only — POST route rejects it; hide from create form */}
                {canManageAdmins && isEditMode && (
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                )}
                {canManageAdmins && (
                  <SelectItem value="admin">Admin</SelectItem>
                )}
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

          {isEditMode && (
            <div className="space-y-2">
              <Label htmlFor="staff-labor-rate">Labor rate ($/hour)</Label>
              <Input
                id="staff-labor-rate"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={form.laborRate}
                onChange={(e) => updateField('laborRate', e.target.value)}
                placeholder="e.g. 75.00"
              />
              <p className="text-xs text-muted-foreground">
                Used for job-cost when a technician clocks time. Leave blank for
                no rate.
              </p>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

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
