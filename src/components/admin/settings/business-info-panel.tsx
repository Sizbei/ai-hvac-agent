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
import type {
  OrgConfig,
  OrgConfigUpdate,
  BusinessInfo,
} from '@/lib/admin/org-config-types';

interface BusinessInfoPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

export function BusinessInfoPanel({ config, onSave }: BusinessInfoPanelProps) {
  const bi = config.businessInfo;
  const [serviceArea, setServiceArea] = useState(bi.serviceArea ?? '');
  const [businessHours, setBusinessHours] = useState(bi.businessHours ?? '');
  const [phone, setPhone] = useState(bi.phone ?? '');
  const [licensedInsured, setLicensedInsured] = useState(
    bi.licensedInsured ?? '',
  );
  const [paymentMethods, setPaymentMethods] = useState(bi.paymentMethods ?? '');
  const [website, setWebsite] = useState(bi.website ?? '');
  const [financing, setFinancing] = useState<boolean>(
    bi.financingAvailable ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setSaved(false);
    // Only include non-empty fields so we don't store empty strings.
    const businessInfo: BusinessInfo = {
      financingAvailable: financing,
    };
    if (serviceArea.trim()) businessInfo.serviceArea = serviceArea.trim();
    if (businessHours.trim()) businessInfo.businessHours = businessHours.trim();
    if (phone.trim()) businessInfo.phone = phone.trim();
    if (licensedInsured.trim())
      businessInfo.licensedInsured = licensedInsured.trim();
    if (paymentMethods.trim())
      businessInfo.paymentMethods = paymentMethods.trim();
    if (website.trim()) businessInfo.website = website.trim();

    const ok = await onSave({ businessInfo });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Business info</CardTitle>
        <CardDescription>
          The assistant uses these to answer common questions with your real
          details instead of generic text.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field
          id="service-area"
          label="Service area"
          value={serviceArea}
          onChange={setServiceArea}
          placeholder="Greater Austin & surrounding counties"
        />
        <Field
          id="business-hours"
          label="Business hours"
          value={businessHours}
          onChange={setBusinessHours}
          placeholder="Mon–Fri 8am–6pm, Sat 9am–2pm"
        />
        <Field
          id="phone"
          label="Phone number"
          value={phone}
          onChange={setPhone}
          placeholder="(555) 123-4567"
        />
        <Field
          id="payment-methods"
          label="Payment methods"
          value={paymentMethods}
          onChange={setPaymentMethods}
          placeholder="all major cards, cash, and check"
        />
        <Field
          id="website"
          label="Website"
          value={website}
          onChange={setWebsite}
          placeholder="https://yourcompany.com"
        />
        <div className="space-y-2">
          <Label htmlFor="licensed">Licensing &amp; insurance statement</Label>
          <textarea
            id="licensed"
            value={licensedInsured}
            onChange={(e) => setLicensedInsured(e.target.value)}
            placeholder="Yes — we're fully licensed (TACLB#…) and insured."
            maxLength={300}
            rows={2}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            Shown verbatim when a customer asks if you&apos;re licensed/insured.
          </p>
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div>
            <Label htmlFor="financing" className="cursor-pointer">
              Financing available
            </Label>
            <p className="text-xs text-muted-foreground">
              Affects how the assistant answers financing questions.
            </p>
          </div>
          <Switch
            id="financing"
            checked={financing}
            onCheckedChange={setFinancing}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4" />
          ) : null}
          {saved ? 'Saved' : 'Save business info'}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
}

function Field({ id, label, value, onChange, placeholder }: FieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={500}
      />
    </div>
  );
}
