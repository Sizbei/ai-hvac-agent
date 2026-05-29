'use client';

import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

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
}

export function EquipmentFormDialog({
  open,
  onOpenChange,
  customerId,
  onSuccess,
}: EquipmentFormDialogProps) {
  const [equipmentType, setEquipmentType] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [locationInHome, setLocationInHome] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!equipmentType) {
        setError('Equipment type is required');
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const res = await fetch(`/api/admin/customers/${customerId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add_equipment',
            equipmentType,
            make: make.trim() || undefined,
            model: model.trim() || undefined,
            serialNumber: serialNumber.trim() || undefined,
            locationInHome: locationInHome.trim() || undefined,
          }),
        });

        const json = await res.json();
        if (json.success) {
          setEquipmentType('');
          setMake('');
          setModel('');
          setSerialNumber('');
          setLocationInHome('');
          onSuccess();
        } else {
          setError(json.error?.message ?? 'Failed to add equipment');
        }
      } catch {
        setError('Network error');
      } finally {
        setIsSubmitting(false);
      }
    },
    [customerId, equipmentType, make, model, serialNumber, locationInHome, onSuccess],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Equipment</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Type *</Label>
            <Select value={equipmentType} onValueChange={(v) => setEquipmentType(v ?? '')}>
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
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="Carrier"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="24ACC636"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="serial">Serial Number</Label>
            <Input
              id="serial"
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              placeholder="SN-12345678"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="location">Location in Home</Label>
            <Input
              id="location"
              value={locationInHome}
              onChange={(e) => setLocationInHome(e.target.value)}
              placeholder="Basement, Attic, Garage, etc."
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
