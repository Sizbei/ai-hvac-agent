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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SERVICE_TAGS } from '@/lib/admin/org-config-types';
import { issueTypeValues } from '@/lib/ai/extraction-schema';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';

interface ServicesPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

const ISSUE_LABELS: Record<string, string> = {
  heating_not_working: 'Heating repair',
  cooling_not_working: 'Cooling / AC repair',
  thermostat_issue: 'Thermostat',
  air_quality: 'Indoor air quality',
  strange_noises: 'Noises / diagnostics',
  water_leak: 'Water leaks',
  maintenance: 'Maintenance / tune-ups',
  installation: 'New installation / replacement',
  other: 'Other HVAC issues',
};

const TAG_LABELS: Record<string, string> = {
  boiler: 'Boilers / hydronic heat',
  water_heater: 'Water heaters',
  commercial: 'Commercial HVAC',
  ductless_minisplit: 'Ductless mini-splits',
  iaq_products: 'IAQ products (UV, purifiers)',
  new_installation: 'New system installs',
  duct_cleaning: 'Duct cleaning',
};

export function ServicesPanel({ config, onSave }: ServicesPanelProps) {
  // We store the DISABLED sets but present them as "offered" toggles (on = we
  // offer it), which is the natural mental model for an admin.
  const [disabledIssues, setDisabledIssues] = useState<Set<string>>(
    new Set(config.disabledIssueTypes),
  );
  const [disabledTags, setDisabledTags] = useState<Set<string>>(
    new Set(config.disabledServiceTags),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function toggle(
    set: Set<string>,
    setter: (s: Set<string>) => void,
    key: string,
    offered: boolean,
  ): void {
    const next = new Set(set);
    // offered === true => NOT disabled.
    if (offered) next.delete(key);
    else next.add(key);
    setter(next);
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({
      disabledIssueTypes: Array.from(disabledIssues) as OrgConfigUpdate['disabledIssueTypes'],
      disabledServiceTags: Array.from(disabledTags) as OrgConfigUpdate['disabledServiceTags'],
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services you offer</CardTitle>
        <CardDescription>
          Turn off anything you don&apos;t do. The assistant will politely
          decline and redirect instead of promising it — emergencies always
          still escalate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <p className="mb-3 text-sm font-medium">Core HVAC services</p>
          <div className="space-y-1">
            {issueTypeValues.map((issue) => {
              const offered = !disabledIssues.has(issue);
              return (
                <div
                  key={issue}
                  className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50"
                >
                  <Label htmlFor={`issue-${issue}`} className="cursor-pointer">
                    {ISSUE_LABELS[issue] ?? issue}
                  </Label>
                  <Switch
                    id={`issue-${issue}`}
                    checked={offered}
                    onCheckedChange={(c) =>
                      toggle(disabledIssues, setDisabledIssues, issue, c)
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium">Specialty services</p>
          <div className="space-y-1">
            {SERVICE_TAGS.map((tag) => {
              const offered = !disabledTags.has(tag);
              return (
                <div
                  key={tag}
                  className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50"
                >
                  <Label htmlFor={`tag-${tag}`} className="cursor-pointer">
                    {TAG_LABELS[tag] ?? tag}
                  </Label>
                  <Switch
                    id={`tag-${tag}`}
                    checked={offered}
                    onCheckedChange={(c) =>
                      toggle(disabledTags, setDisabledTags, tag, c)
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4" />
          ) : null}
          {saved ? 'Saved' : 'Save services'}
        </Button>
      </CardFooter>
    </Card>
  );
}
