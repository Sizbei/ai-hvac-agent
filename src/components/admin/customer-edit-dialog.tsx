'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        setError('Name is required');
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
          setError(json.error?.message ?? 'Failed to update customer');
        }
      } catch {
        setError('Network error');
      } finally {
        setIsSubmitting(false);
      }
    },
    [customerId, name, phone, email, address, propertyType, propertySqft, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Customer</DialogTitle>
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
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 010-0100"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-address">Address</Label>
            <Input
              id="edit-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="123 Main St, Springfield"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-property-type">Property Type</Label>
              <Input
                id="edit-property-type"
                value={propertyType}
                onChange={(e) => setPropertyType(e.target.value)}
                placeholder="Single-family, Condo, etc."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-sqft">Square Feet</Label>
              <Input
                id="edit-sqft"
                inputMode="numeric"
                value={propertySqft}
                onChange={(e) => setPropertySqft(e.target.value)}
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
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
