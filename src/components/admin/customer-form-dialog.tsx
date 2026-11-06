'use client';

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import {
  isCustomerFormDirty,
  phoneInputError,
  saveErrorMessage,
} from '@/lib/admin/customer-validation';

/** The existing customer a duplicate email/phone clashed with (ids only). */
interface ExistingCustomer {
  readonly customerId: string;
  readonly archived: boolean;
}

const SAVE_FAILED = "Couldn't save the customer. Please try again.";

interface CustomerFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSuccess: () => void;
}

export function CustomerFormDialog({
  open,
  onOpenChange,
  onSuccess,
}: CustomerFormDialogProps) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingCustomer | null>(null);
  const submittingRef = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const resetFields = (): void => {
    setName('');
    setPhone('');
    setEmail('');
    setAddress('');
    setPropertyType('');
    setError(null);
    setExisting(null);
  };

  // Esc, the X, the backdrop and Cancel ask first when something was typed.
  const requestClose = (): void => {
    if (submittingRef.current) return;
    if (isCustomerFormDirty([name, phone, email, address, propertyType])) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };

  const discard = (): void => {
    setDiscardOpen(false);
    resetFields();
    onOpenChange(false);
  };

  // Editing any field clears the previous attempt's error so it can't sit next
  // to a field that is already fixed.
  const edit =
    (set: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      set(e.target.value);
      setError(null);
      setExisting(null);
    };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        setError('Name is required.');
        return;
      }
      const phoneError = phoneInputError(phone);
      if (phoneError) {
        setError(phoneError);
        return;
      }
      if (submittingRef.current) return;
      submittingRef.current = true;

      setIsSubmitting(true);
      setError(null);
      setExisting(null);

      try {
        const res = await fetch('/api/admin/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            address: address.trim() || undefined,
            propertyType: propertyType.trim() || undefined,
          }),
        });

        const json = await res.json().catch(() => null);
        if (res.ok && json?.success) {
          resetFields();
          onSuccess();
        } else {
          setError(saveErrorMessage(res.status, json, SAVE_FAILED));
          const details = json?.error?.details as ExistingCustomer | undefined;
          if (res.status === 409 && typeof details?.customerId === 'string') {
            setExisting(details);
          }
        }
      } catch {
        setError(SAVE_FAILED);
      } finally {
        setIsSubmitting(false);
        submittingRef.current = false;
      }
    },
    [name, phone, email, address, propertyType, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add customer</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {error}
                {existing && (
                  <Link
                    href={`/admin/customers/${existing.customerId}`}
                    className="mt-1 block font-medium text-link underline-offset-2 hover:underline"
                  >
                    {existing.archived
                      ? 'Open the archived customer'
                      : 'Open the existing customer'}
                  </Link>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={edit(setName)}
              placeholder="John Smith"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={phone}
              onChange={edit(setPhone)}
              placeholder="(555) 123-4567"
              inputMode="tel"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={edit(setEmail)}
              placeholder="john@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              value={address}
              onChange={edit(setAddress)}
              placeholder="123 Main St, City, ST 12345"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="propertyType">Property type</Label>
            <Input
              id="propertyType"
              value={propertyType}
              onChange={edit(setPropertyType)}
              placeholder="Residential, Commercial, etc."
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this customer?"
        description="What you’ve entered will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={discard}
      />
    </Dialog>
  );
}
