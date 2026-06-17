'use client';

import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { EquipmentRecord } from '@/lib/admin/crm-types';

const EQUIPMENT_TYPES = [
  { value: 'ac', label: 'Air Conditioner' },
  { value: 'furnace', label: 'Furnace' },
  { value: 'heat_pump', label: 'Heat Pump' },
  { value: 'boiler', label: 'Boiler' },
  { value: 'mini_split', label: 'Mini Split' },
  { value: 'thermostat', label: 'Thermostat' },
  { value: 'other', label: 'Other' },
] as const;

interface EquipmentFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customerId: string;
  readonly onSuccess: () => void;
  /** When provided, the dialog edits this row; otherwise it adds a new one. */
  readonly equipment?: EquipmentRecord | null;
}

interface FormState {
  readonly equipmentType: string;
  readonly make: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly locationInHome: string;
  readonly installDate: string;
  readonly warrantyExpiration: string;
  readonly warrantyType: string;
  readonly warrantyProvider: string;
  readonly notes: string;
}

const EMPTY_FORM: FormState = {
  equipmentType: '',
  make: '',
  model: '',
  serialNumber: '',
  locationInHome: '',
  installDate: '',
  warrantyExpiration: '',
  warrantyType: '',
  warrantyProvider: '',
  notes: '',
};

/** A date <input type="date"> wants YYYY-MM-DD; the record stores an ISO
 * timestamp. Slice the date part (empty string if absent). */
function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

function formFromEquipment(equipment: EquipmentRecord | null | undefined): FormState {
  if (!equipment) return EMPTY_FORM;
  return {
    equipmentType: equipment.equipmentType,
    make: equipment.make ?? '',
    model: equipment.model ?? '',
    serialNumber: equipment.serialNumber ?? '',
    locationInHome: equipment.locationInHome ?? '',
    installDate: toDateInput(equipment.installDate),
    warrantyExpiration: toDateInput(equipment.warrantyExpiration),
    warrantyType: equipment.warrantyType ?? '',
    warrantyProvider: equipment.warrantyProvider ?? '',
    notes: equipment.notes ?? '',
  };
}

export function EquipmentFormDialog({
  open,
  onOpenChange,
  customerId,
  onSuccess,
  equipment,
}: EquipmentFormDialogProps) {
  const isEditMode = equipment != null;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(formFromEquipment(equipment));
      setError(null);
    }
  }, [open, equipment]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.equipmentType) {
        setError('Equipment type is required');
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        // On edit, send the trimmed value or empty string (the route maps
        // empty → null, clearing the field). On add, omit empties.
        const body = isEditMode
          ? {
              action: 'update_equipment',
              equipmentId: equipment.id,
              equipmentType: form.equipmentType,
              make: form.make.trim(),
              model: form.model.trim(),
              serialNumber: form.serialNumber.trim(),
              locationInHome: form.locationInHome.trim(),
              installDate: form.installDate,
              warrantyExpiration: form.warrantyExpiration,
              warrantyType: form.warrantyType.trim(),
              warrantyProvider: form.warrantyProvider.trim(),
              notes: form.notes.trim(),
            }
          : {
              action: 'add_equipment',
              equipmentType: form.equipmentType,
              make: form.make.trim() || undefined,
              model: form.model.trim() || undefined,
              serialNumber: form.serialNumber.trim() || undefined,
              locationInHome: form.locationInHome.trim() || undefined,
              installDate: form.installDate || undefined,
              warrantyExpiration: form.warrantyExpiration || undefined,
              warrantyType: form.warrantyType.trim() || undefined,
              warrantyProvider: form.warrantyProvider.trim() || undefined,
              notes: form.notes.trim() || undefined,
            };

        const res = await fetch(`/api/admin/customers/${customerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const json = await res.json();
        if (json.success) {
          onSuccess();
        } else {
          setError(
            json.error?.message ??
              `Failed to ${isEditMode ? 'update' : 'add'} equipment`,
          );
        }
      } catch {
        setError('Network error');
      } finally {
        setIsSubmitting(false);
      }
    },
    [customerId, form, isEditMode, equipment, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Equipment' : 'Add Equipment'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Type *</Label>
            <Select
              value={form.equipmentType}
              onValueChange={(v) => update('equipmentType', v ?? '')}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select equipment type" />
              </SelectTrigger>
              <SelectContent>
                {EQUIPMENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="make">Make</Label>
              <Input
                id="make"
                value={form.make}
                onChange={(e) => update('make', e.target.value)}
                placeholder="Carrier"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={form.model}
                onChange={(e) => update('model', e.target.value)}
                placeholder="24ACC636"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="serial">Serial Number</Label>
            <Input
              id="serial"
              value={form.serialNumber}
              onChange={(e) => update('serialNumber', e.target.value)}
              placeholder="SN-12345678"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="location">Location in Home</Label>
            <Input
              id="location"
              value={form.locationInHome}
              onChange={(e) => update('locationInHome', e.target.value)}
              placeholder="Basement, Attic, Garage, etc."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="install-date">Install Date</Label>
              <Input
                id="install-date"
                type="date"
                value={form.installDate}
                onChange={(e) => update('installDate', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="warranty">Warranty Expiration</Label>
              <Input
                id="warranty"
                type="date"
                value={form.warrantyExpiration}
                onChange={(e) => update('warrantyExpiration', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="warranty-type">Warranty Type</Label>
              <Input
                id="warranty-type"
                value={form.warrantyType}
                onChange={(e) => update('warrantyType', e.target.value)}
                placeholder="Manufacturer, labor, extended"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="warranty-provider">Warranty Provider</Label>
              <Input
                id="warranty-provider"
                value={form.warrantyProvider}
                onChange={(e) => update('warrantyProvider', e.target.value)}
                placeholder="Carrier, Trane, third-party plan"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="equipment-notes">Notes</Label>
            <textarea
              id="equipment-notes"
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="Any additional details about this unit"
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
