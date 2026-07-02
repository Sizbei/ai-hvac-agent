'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';

interface DispatchPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

export function DispatchPanel({ config, onSave }: DispatchPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleToggle(next: boolean): Promise<void> {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({ autoDispatchEnabled: next });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-dispatch</CardTitle>
        <CardDescription>
          When on, a newly booked job is automatically assigned to the best
          qualified technician — ranked by their experience with the job type,
          their ratings, and how busy their day already is. When off, jobs are
          assigned to the first available technician.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="auto-dispatch-switch">Smart auto-dispatch</Label>
            <p className="text-sm text-muted-foreground">
              Assign by skill, quality, and load instead of first-available.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {saving && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            {saved && <Check className="size-4 text-green-600" />}
            <Switch
              id="auto-dispatch-switch"
              checked={config.autoDispatchEnabled}
              disabled={saving}
              onCheckedChange={(v) => void handleToggle(v)}
              aria-label="Toggle smart auto-dispatch"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
