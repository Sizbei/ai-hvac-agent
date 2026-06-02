'use client';

import { useState } from 'react';
import { Check, Loader2, MessageCircle } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LAUNCHER_POSITIONS } from '@/lib/admin/org-config-types';
import type {
  OrgConfig,
  OrgConfigUpdate,
  LauncherPosition,
} from '@/lib/admin/org-config-types';

interface BrandingPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DEFAULT_COLOR = '#2563eb';

export function BrandingPanel({ config, onSave }: BrandingPanelProps) {
  const [companyName, setCompanyName] = useState(config.companyName ?? '');
  const [primaryColor, setPrimaryColor] = useState(
    config.primaryColor ?? DEFAULT_COLOR,
  );
  const [welcomeMessage, setWelcomeMessage] = useState(
    config.welcomeMessage ?? '',
  );
  const [logoUrl, setLogoUrl] = useState(config.logoUrl ?? '');
  const [launcherPosition, setLauncherPosition] = useState<LauncherPosition>(
    config.launcherPosition,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const colorValid = HEX.test(primaryColor);
  const previewColor = colorValid ? primaryColor : DEFAULT_COLOR;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({
      companyName: companyName.trim() || null,
      primaryColor: colorValid ? primaryColor : null,
      welcomeMessage: welcomeMessage.trim() || null,
      logoUrl: logoUrl.trim() || null,
      launcherPosition,
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_280px]">
      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
          <CardDescription>
            How your widget looks on your website.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="company-name">Company name</Label>
            <Input
              id="company-name"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Heating & Cooling"
              maxLength={120}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="primary-color">Primary color</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label="Pick primary color"
                value={previewColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="size-9 cursor-pointer rounded-md border bg-transparent p-0"
              />
              <Input
                id="primary-color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                placeholder="#2563eb"
                aria-invalid={!colorValid}
                className="max-w-[140px] font-mono"
              />
              {!colorValid && (
                <span className="text-xs text-destructive">
                  Enter a hex color
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="logo-url">Logo URL (optional)</Label>
            <Input
              id="logo-url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://yoursite.com/logo.png"
              maxLength={500}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="welcome">Welcome message</Label>
            <textarea
              id="welcome"
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
              placeholder="Hi! How can we help with your heating or cooling today?"
              maxLength={500}
              rows={3}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <div className="space-y-2">
            <Label>Launcher position</Label>
            <Select
              value={launcherPosition}
              onValueChange={(v) => setLauncherPosition(v as LauncherPosition)}
            >
              <SelectTrigger className="max-w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAUNCHER_POSITIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p === 'bottom-right' ? 'Bottom right' : 'Bottom left'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={handleSave} disabled={saving || !colorValid}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : saved ? (
              <Check className="size-4" />
            ) : null}
            {saved ? 'Saved' : 'Save branding'}
          </Button>
        </CardFooter>
      </Card>

      {/* Live preview */}
      <div className="space-y-2">
        <Label className="text-muted-foreground">Live preview</Label>
        <div className="relative h-[320px] overflow-hidden rounded-xl border bg-gradient-to-b from-muted/40 to-muted/10">
          <div
            className={cn(
              'absolute bottom-4 w-[220px] overflow-hidden rounded-2xl border bg-background shadow-xl',
              launcherPosition === 'bottom-right' ? 'right-4' : 'left-4',
            )}
          >
            <div
              className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-white"
              style={{ backgroundColor: previewColor }}
            >
              <MessageCircle className="size-4" />
              <span className="truncate">{companyName || 'Your Company'}</span>
            </div>
            <div className="space-y-2 p-3">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-xs">
                {welcomeMessage ||
                  'Hi! How can we help with your heating or cooling today?'}
              </div>
              <div
                className="ml-auto max-w-[70%] rounded-2xl rounded-tr-sm px-3 py-2 text-xs text-white"
                style={{ backgroundColor: previewColor }}
              >
                My AC isn&apos;t cooling.
              </div>
            </div>
          </div>
          <div
            className={cn(
              'absolute bottom-4 flex size-12 items-center justify-center rounded-full text-white shadow-lg',
              launcherPosition === 'bottom-right' ? 'right-4' : 'left-4',
              'translate-y-[120%]',
            )}
            style={{ backgroundColor: previewColor }}
          >
            <MessageCircle className="size-6" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          A rough preview of the widget bubble and panel.
        </p>
      </div>
    </div>
  );
}
