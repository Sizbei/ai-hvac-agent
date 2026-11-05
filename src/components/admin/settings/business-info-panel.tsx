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
import { Textarea } from '@/components/ui/textarea';
import {
  businessInfoSchema,
  type OrgConfig,
  type OrgConfigUpdate,
} from '@/lib/admin/org-config-types';
import { settingsFieldErrorCopy } from '@/lib/admin/settings-errors';
import { mergeBusinessInfo } from '@/lib/admin/business-info-merge';

interface BusinessInfoPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

export function BusinessInfoPanel({ config, onSave }: BusinessInfoPanelProps) {
  const bi = config.businessInfo;
  const [serviceArea, setServiceArea] = useState(bi.serviceArea ?? '');
  const [businessHours, setBusinessHours] = useState(bi.businessHours ?? '');
  const [phone, setPhone] = useState(bi.phone ?? '');
  const [email, setEmail] = useState(bi.email ?? '');
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
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    // The PATCH replaces businessInfo wholesale, so merge onto the stored
    // object: keys this panel doesn't edit must survive the save.
    const businessInfo = mergeBusinessInfo(config.businessInfo, {
      serviceArea,
      businessHours,
      phone,
      email,
      licensedInsured,
      paymentMethods,
      website,
      financingAvailable: financing,
    });
    const parsed = businessInfoSchema.safeParse(businessInfo);
    if (!parsed.success) {
      setSaved(false);
      setError(
        settingsFieldErrorCopy(['businessInfo', ...(parsed.error.issues[0]?.path ?? [])]) ??
          "Some details aren't valid. Check the fields and try again.",
      );
      return;
    }
    setError(null);
    setSaving(true);
    setSaved(false);

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
          maxLength={500}
        />
        <Field
          id="business-hours"
          label="Business hours"
          value={businessHours}
          onChange={setBusinessHours}
          placeholder="Mon–Fri 8am–6pm, Sat 9am–2pm"
          maxLength={300}
          hint="What the assistant tells customers. Which requests count as after-hours is set on the After-hours tab, so keep the two in step."
        />
        <Field
          id="phone"
          label="Phone number"
          value={phone}
          onChange={setPhone}
          placeholder="(555) 123-4567"
          maxLength={40}
          type="tel"
        />
        <Field
          id="business-email"
          label="Contact email"
          value={email}
          onChange={setEmail}
          placeholder="office@yourcompany.com"
          maxLength={254}
          type="email"
        />
        <Field
          id="payment-methods"
          label="Payment methods"
          value={paymentMethods}
          onChange={setPaymentMethods}
          placeholder="all major cards, cash, and check"
          maxLength={300}
        />
        <Field
          id="website"
          label="Website"
          value={website}
          onChange={setWebsite}
          placeholder="https://yourcompany.com"
          maxLength={300}
          type="url"
        />
        <div className="space-y-2">
          <Label htmlFor="licensed">Licensing &amp; insurance statement</Label>
          <Textarea
            id="licensed"
            value={licensedInsured}
            onChange={(e) => setLicensedInsured(e.target.value)}
            placeholder="Yes — we're fully licensed (TACLB#…) and insured."
            maxLength={300}
            rows={2}
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
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
  readonly maxLength: number;
  readonly type?: string;
  readonly hint?: string;
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  type,
  hint,
}: FieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
