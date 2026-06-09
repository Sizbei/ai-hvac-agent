'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  afterHoursConfigSchema,
  DEFAULT_AFTER_HOURS_CONFIG,
} from '@/lib/admin/after-hours';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';

interface AfterHoursPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

export function AfterHoursPanel({ config, onSave }: AfterHoursPanelProps) {
  const current = config.afterHoursConfig;
  const [enabled, setEnabled] = useState(current.enabled);
  const [startHour, setStartHour] = useState(String(current.startHour));
  const [endHour, setEndHour] = useState(String(current.endHour));
  const [weekends, setWeekends] = useState(current.weekendsAreAfterHours);
  const [timezone, setTimezone] = useState(current.timezone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    const candidate = {
      enabled,
      startHour: Number(startHour),
      endHour: Number(endHour),
      weekendsAreAfterHours: weekends,
      timezone: timezone.trim(),
    };

    const parsed = afterHoursConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ??
          'Some values are out of range. Please check the fields and try again.',
      );
      return;
    }

    setError(null);
    setSaving(true);
    setSaved(false);
    const ok = await onSave({ afterHoursConfig: parsed.data });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>After-hours window</CardTitle>
        <CardDescription>
          Requests that arrive outside business hours are flagged so dispatch and
          the customer record can react. After-hours visits may carry an
          additional charge based on the work performed — no fixed fee is
          configured here. All times use the org timezone below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50">
          <Label htmlFor="after-hours-enabled" className="cursor-pointer">
            After-hours flagging enabled
          </Label>
          <Switch
            id="after-hours-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="after-hours-start">After-hours begins (hour, 0–23)</Label>
          <Input
            id="after-hours-start"
            inputMode="numeric"
            value={startHour}
            onChange={(e) => setStartHour(e.target.value)}
            placeholder={`Default: ${DEFAULT_AFTER_HOURS_CONFIG.startHour}`}
          />
          <p className="text-xs text-muted-foreground">
            Hour the after-hours window starts (e.g. 18 = 6pm). Range 0–23.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="after-hours-end">Business day begins (hour, 0–23)</Label>
          <Input
            id="after-hours-end"
            inputMode="numeric"
            value={endHour}
            onChange={(e) => setEndHour(e.target.value)}
            placeholder={`Default: ${DEFAULT_AFTER_HOURS_CONFIG.endHour}`}
          />
          <p className="text-xs text-muted-foreground">
            Hour normal business hours resume (e.g. 8 = 8am). Range 0–23.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50">
          <Label htmlFor="after-hours-weekends" className="cursor-pointer">
            Treat weekends as after-hours
          </Label>
          <Switch
            id="after-hours-weekends"
            checked={weekends}
            onCheckedChange={setWeekends}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="after-hours-timezone">Timezone</Label>
          <Input
            id="after-hours-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder={DEFAULT_AFTER_HOURS_CONFIG.timezone}
          />
          <p className="text-xs text-muted-foreground">
            IANA timezone (e.g. America/New_York). All after-hours time math uses
            this clock.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      <CardFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4" />
          ) : null}
          {saved ? 'Saved' : 'Save after-hours window'}
        </Button>
      </CardFooter>
    </Card>
  );
}
