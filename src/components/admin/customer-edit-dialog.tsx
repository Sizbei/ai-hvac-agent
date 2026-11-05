'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { phoneInputError, saveErrorMessage } from '@/lib/admin/customer-validation';

const SAVE_FAILED = "Couldn't save the customer. Please try again.";
const digitsOf = (v: string | null): string => (v ?? '').replace(/\D/g, '');

interface CustomerEditValues {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly propertyType: string | null;
  readonly propertySqft: number | null;
}

interface CustomerEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customerId: string;
  readonly initial: CustomerEditValues;
  readonly onSuccess: () => void;
}

export function CustomerEditDialog({
  open,
  onOpenChange,
  customerId,
  initial,
  onSuccess,
}: CustomerEditDialogProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [address, setAddress] = useState(initial.address ?? '');
  const [propertyType, setPropertyType] = useState(initial.propertyType ?? '');
  const [propertySqft, setPropertySqft] = useState(
    initial.propertySqft != null ? String(initial.propertySqft) : '',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form on each open transition so it reflects the latest saved
  // values, not stale edits from a previous cancelled session. This is the
  // React "adjust state during render" pattern (cheaper than an effect, no
  // cascading render): when `open` flips false→true we reset synchronously.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(initial.name ?? '');
      setPhone(initial.phone ?? '');
      setEmail(initial.email ?? '');
      setAddress(initial.address ?? '');
      setPropertyType(initial.propertyType ?? '');
      setPropertySqft(initial.propertySqft != null ? String(initial.propertySqft) : '');
      setError(null);
    }
  }

  // Editing a field clears the previous attempt's error.
  const edit =
    (set: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      set(e.target.value);
      setError(null);
    };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        setError('Name is required.');
        return;
      }
      // Only a changed number is checked, so a legacy short number on file
      // doesn't block an unrelated edit (the API applies the same rule).
      const phoneError =
        digitsOf(phone) !== digitsOf(initial.phone) ? phoneInputError(phone) : null;
      if (phoneError) {
        setError(phoneError);
        return;
      }

      setIsSubmitting(true);
      setError(null);

      // Send every contact field explicitly so blanking one clears it
      // server-side (the API reads "key in body" to distinguish clear from
      // leave-untouched). propertySqft is sent as a number or null.
      const sqftTrimmed = propertySqft.trim();
      const sqftValue =
        sqftTrimmed.length > 0 && Number.isFinite(Number(sqftTrimmed))
          ? Number(sqftTrimmed)
          : null;

      try {
        const res = await fetch(`/api/admin/customers/${customerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_contact',
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            address: address.trim(),
            propertyType: propertyType.trim(),
            propertySqft: sqftValue,
          }),
        });

        const json = await res.json().catch(() => ({ success: false }));
        if (res.ok && json.success) {
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
    [customerId, name, phone, email, address, propertyType, propertySqft, onSuccess, initial.phone],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="edit-name">Name *</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={edit(setName)}
              placeholder="Jane Doe"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                value={phone}
                onChange={edit(setPhone)}
                placeholder="(555) 010-0100"
                inputMode="tel"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={email}
                onChange={edit(setEmail)}
                placeholder="jane@example.com"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-address">Address</Label>
            <Input
              id="edit-address"
              value={address}
              onChange={edit(setAddress)}
              placeholder="123 Main St, Springfield"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-property-type">Property type</Label>
              <Input
                id="edit-property-type"
                value={propertyType}
                onChange={edit(setPropertyType)}
                placeholder="Single-family, Condo, etc."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-sqft">Square feet</Label>
              <Input
                id="edit-sqft"
                inputMode="numeric"
                value={propertySqft}
                onChange={edit(setPropertySqft)}
                placeholder="2000"
              />
            </div>
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
