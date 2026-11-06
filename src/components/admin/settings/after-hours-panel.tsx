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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { afterHoursConfigSchema } from '@/lib/admin/after-hours';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';
import { settingsFieldErrorCopy } from '@/lib/admin/settings-errors';
import {
  HOUR_OPTIONS,
  timezoneOptions,
  type Option,
} from '@/lib/admin/after-hours-options';
import { hasUnsavedChanges } from '@/lib/admin/unsaved-changes';
import { useReportDirty } from '@/hooks/use-unsaved-changes-guard';

interface AfterHoursPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
  /** Called when the draft starts or stops differing from what's saved. */
  readonly onDirtyChange?: (dirty: boolean) => void;
}

export function AfterHoursPanel({ config, onSave, onDirtyChange }: AfterHoursPanelProps) {
  const current = config.afterHoursConfig;
  const [enabled, setEnabled] = useState(current.enabled);
  const [startHour, setStartHour] = useState(String(current.startHour));
  const [endHour, setEndHour] = useState(String(current.endHour));
  const [weekends, setWeekends] = useState(current.weekendsAreAfterHours);
  const [timezone, setTimezone] = useState(current.timezone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = hasUnsavedChanges(
    {
      enabled: current.enabled,
      startHour: String(current.startHour),
      endHour: String(current.endHour),
      weekends: current.weekendsAreAfterHours,
      timezone: current.timezone,
    },
    { enabled, startHour, endHour, weekends, timezone },
  );
  useReportDirty(dirty, onDirtyChange);

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
        settingsFieldErrorCopy(['afterHoursConfig', ...(parsed.error.issues[0]?.path ?? [])]) ??
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

        <OptionSelect
          id="after-hours-end"
          label="Business day begins"
          value={endHour}
          onChange={setEndHour}
          options={HOUR_OPTIONS}
          hint="When normal business hours start each weekday."
        />

        <OptionSelect
          id="after-hours-start"
          label="After-hours begins"
          value={startHour}
          onChange={setStartHour}
          options={HOUR_OPTIONS}
          hint="Requests from this hour until the business day begins are flagged as after-hours."
        />

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

        <OptionSelect
          id="after-hours-timezone"
          label="Timezone"
          value={timezone}
          onChange={setTimezone}
          options={timezoneOptions(current.timezone)}
          hint="The hours above are read on this clock."
        />

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

function OptionSelect({
  id,
  label,
  value,
  onChange,
  options,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly options: readonly Option[];
  readonly hint: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => v != null && onChange(v)}>
        <SelectTrigger id={id} className="w-full sm:w-72" aria-describedby={`${id}-hint`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
